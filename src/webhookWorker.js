'use strict';

const { WebhookEvent } = require('./models');
const { deliverWebhook } = require('./webhookDelivery');
const {
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
  webhookDlqSize,
  webhookAttemptsTotal,
  webhookOldestPendingAgeSeconds,
  webhookDlqOldestAgeSeconds,
} = require('./metrics');

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

function backoffDelayMs(attempt) {
  return BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }
  try {
    return new URL(url).hostname || null;
  } catch (err) {
    return null;
  }
}

function safeLogContext(event) {
  return {
    event_id: event && event.id ? event.id : null,
    event_type: event && event.event_type ? event.event_type : null,
    merchant_id: event && event.merchant_id ? event.merchant_id : null,
    webhook_domain: redactUrl(event && event.url),
  };
}

function recordAttempt(attempt) {
  try {
    if (webhookAttemptsTotal && typeof webhookAttemptsTotal.inc === 'function') {
      webhookAttemptsTotal.inc({ attempt: String(attempt) });
    }
  } catch (err) {
    // best-effort: metrics must never break delivery
  }
}

function observeDuration(durationSeconds) {
  try {
    if (
      webhookDeliveryDurationSeconds &&
      typeof webhookDeliveryDurationSeconds.observe === 'function'
    ) {
      webhookDeliveryDurationSeconds.observe(durationSeconds);
    }
  } catch (err) {
    // best-effort: metrics must never break delivery
  }
}

function ageSecondsFrom(date) {
  if (!date) {
    return null;
  }
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  const age = (Date.now() - ms) / 1000;
  return age > 0 ? age : 0;
}

async function refreshQueueHealthMetrics() {
  try {
    const oldestPending = await WebhookEvent.findOne({
      where: { status: ['pending', 'retrying'] },
      order: [['created_at', 'ASC']],
      attributes: ['created_at'],
    });
    const pendingAge = oldestPending ? ageSecondsFrom(oldestPending.created_at) : null;
    if (
      webhookOldestPendingAgeSeconds &&
      typeof webhookOldestPendingAgeSeconds.set === 'function'
    ) {
      webhookOldestPendingAgeSeconds.set(pendingAge === null ? 0 : pendingAge);
    }
  } catch (err) {
    // best-effort: DB may be unavailable
  }

  try {
    const oldestDlq = await WebhookEvent.findOne({
      where: { status: 'dead_letter' },
      order: [['created_at', 'ASC']],
      attributes: ['created_at'],
    });
    const dlqAge = oldestDlq ? ageSecondsFrom(oldestDlq.created_at) : null;
    if (webhookDlqOldestAgeSeconds && typeof webhookDlqOldestAgeSeconds.set === 'function') {
      webhookDlqOldestAgeSeconds.set(dlqAge === null ? 0 : dlqAge);
    }
  } catch (err) {
    // best-effort: DB may be unavailable
  }
}

async function processWebhookEvent(event) {
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    recordAttempt(attempt);

    let response;
    const deliveryStart = process.hrtime.bigint();
    try {
      response = await deliverWebhook(event);
    } catch (err) {
      const durationSeconds = Number(process.hrtime.bigint() - deliveryStart) / 1e9;
      observeDuration(durationSeconds);
      lastError = err && err.message ? err.message : String(err);
      await event.update({ attempt_count: attempt, last_error: lastError });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      break;
    }

    const durationSeconds = Number(process.hrtime.bigint() - deliveryStart) / 1e9;
    observeDuration(durationSeconds);

    if (response && response.status >= 200 && response.status < 300) {
      await event.update({
        status: 'delivered',
        attempt_count: attempt,
        last_error: null,
        delivered_at: new Date(),
      });
      webhookDeliveriesTotal.inc({ status: 'success' });
      await refreshQueueHealthMetrics();
      return event;
    }

    const status = response ? response.status : null;
    lastError = `HTTP ${status}`;
    await event.update({ attempt_count: attempt, last_error: lastError });

    if (!isRetryableStatus(status)) {
      break;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(backoffDelayMs(attempt));
    }
  }

  await event.update({
    status: 'failed',
    attempt_count: attempt,
    last_error: lastError,
  });
  webhookDeliveriesTotal.inc({ status: 'failure' });
  await moveToDeadLetterQueue(event);
  await refreshQueueHealthMetrics();
  return event;
}

async function moveToDeadLetterQueue(event) {
  await WebhookEvent.create({
    event_type: event.event_type,
    payload: event.payload,
    merchant_id: event.merchant_id,
    status: 'dead_letter',
    attempt_count: event.attempt_count,
    last_error: event.last_error,
    original_event_id: event.id,
  });
  const dlqDepth = await WebhookEvent.count({ where: { status: 'dead_letter' } });
  webhookDlqSize.set(dlqDepth);
}

module.exports = {
  processWebhookEvent,
  isRetryableStatus,
  backoffDelayMs,
  redactUrl,
  safeLogContext,
  refreshQueueHealthMetrics,
  MAX_ATTEMPTS,
  RETRYABLE_STATUS_CODES,
};
