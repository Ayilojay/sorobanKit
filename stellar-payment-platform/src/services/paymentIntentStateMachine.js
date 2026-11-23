'use strict';

const { EventEmitter } = require('events');
const { ApiError } = require('../errors');

/**
 * Valid state transitions for a payment intent.
 *
 * Terminal states (COMPLETED, FAILED, CANCELLED) have no outgoing transitions.
 */
const VALID_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['PROCESSING', 'CANCELLED']),
  PROCESSING: Object.freeze(['COMPLETED', 'FAILED']),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

const ALL_STATUSES = Object.freeze(Object.keys(VALID_TRANSITIONS));

/**
 * Statuses that represent an intent which has been submitted but not yet
 * reconciled (i.e. not in a terminal state).
 */
const UNRECONCILED_STATUSES = Object.freeze(['PENDING', 'PROCESSING']);

/**
 * Statuses that represent a terminal (final) outcome.
 */
const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Returns true if `status` is a terminal state.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Returns true if transitioning from `from` to `to` is allowed.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.includes(to);
}

/**
 * Throws an ApiError('CONFLICT') if the transition is not allowed.
 *
 * @param {string} from
 * @param {string} to
 * @param {string} [paymentIntentId]
 */
function assertValidTransition(from, to, paymentIntentId) {
  if (!isValidTransition(from, to)) {
    const idSuffix = paymentIntentId ? ` for payment intent ${paymentIntentId}` : '';
    throw new ApiError(
      'CONFLICT',
      `Invalid payment intent status transition from ${from} to ${to}${idSuffix}`
    );
  }
}

/**
 * Builds a Prisma `where` clause that only matches the record if it is still
 * in the expected `from` status. This makes the update atomic: if another
 * writer changed the status in the meantime, the update matches zero rows.
 *
 * @param {string} id
 * @param {string} from
 * @returns {object}
 */
function buildGuardedWhere(id, from) {
  return { id, status: from };
}

/**
 * Performs a guarded status update on a payment intent.
 *
 * The update is concurrency-safe: the `where` clause includes the expected
 * current status, so two concurrent updates from the same source status cannot
 * both succeed. The loser observes `count === 0` and receives a CONFLICT.
 *
 * @param {object} prisma - Prisma client (or transaction client)
 * @param {object} params
 * @param {string} params.id - Payment intent id
 * @param {string} params.to - Target status
 * @param {object} [params.data] - Additional fields to update
 * @returns {Promise<object>} The updated payment intent
 */
async function updatePaymentIntentStatus(prisma, { id, to, data = {}, eventStream } = {}) {
  if (!ALL_STATUSES.includes(to)) {
    throw new ApiError('CONFLICT', `Unknown payment intent status: ${to}`);
  }

  const current = await prisma.paymentIntent.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!current) {
    throw new ApiError('NOT_FOUND', `Payment intent ${id} not found`);
  }

  assertValidTransition(current.status, to, id);

  const result = await prisma.paymentIntent.updateMany({
    where: buildGuardedWhere(id, current.status),
    data: { ...data, status: to },
  });

  if (!result || result.count === 0) {
    // Another writer changed the status between our read and write.
    throw new ApiError(
      'CONFLICT',
      `Payment intent ${id} was modified concurrently; status transition to ${to} rejected`
    );
  }

  const updated = await prisma.paymentIntent.findUnique({ where: { id } });
  publishStatusEvent(eventStream, {
    paymentIntentId: id,
    status: to,
    previousStatus: current.status,
    data: updated,
  });
  return updated;
}

/**
 * Publishes a status event to the given stream (or the process-wide default).
 *
 * @param {PaymentIntentEventStream} [eventStream]
 * @param {object} params
 */
function publishStatusEvent(eventStream, params) {
  const stream = eventStream || defaultEventStream;
  if (!stream || typeof stream.publish !== 'function') {
    return null;
  }
  return stream.publish(params);
}

/**
 * Concurrency-safe transition that performs the read, validation, and write
 * inside a single transaction using a conditional update. Prefer this when a
 * transaction client is available.
 *
 * @param {object} prisma - Prisma client
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.to
 * @param {object} [params.data]
 * @returns {Promise<object>}
 */
async function updatePaymentIntentStatusTx(prisma, { id, to, data = {}, eventStream } = {}) {
  if (!ALL_STATUSES.includes(to)) {
    throw new ApiError('CONFLICT', `Unknown payment intent status: ${to}`);
  }

  const { updated, previousStatus } = await prisma.$transaction(async (tx) => {
    const current = await tx.paymentIntent.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!current) {
      throw new ApiError('NOT_FOUND', `Payment intent ${id} not found`);
    }

    assertValidTransition(current.status, to, id);

    const result = await tx.paymentIntent.updateMany({
      where: buildGuardedWhere(id, current.status),
      data: { ...data, status: to },
    });

    if (!result || result.count === 0) {
      throw new ApiError(
        'CONFLICT',
        `Payment intent ${id} was modified concurrently; status transition to ${to} rejected`
      );
    }

    const record = await tx.paymentIntent.findUnique({ where: { id } });
    return { updated: record, previousStatus: current.status };
  });

  // Publish only after the transaction commits so subscribers never observe
  // events for rolled-back transitions.
  publishStatusEvent(eventStream, {
    paymentIntentId: id,
    status: to,
    previousStatus,
    data: updated,
  });
  return updated;
}

/**
 * Computes the age (in milliseconds) of the oldest unreconciled payment intent
 * per network. Only PENDING/PROCESSING intents are considered. The returned
 * map is keyed by network and contains no user identifiers.
 *
 * @param {object} prisma - Prisma client
 * @param {object} [options]
 * @param {Date} [options.now] - Reference time (defaults to `new Date()`)
 * @returns {Promise<Object<string, {oldestIntentId: string, oldestSubmittedAt: Date, ageMs: number}>>}
 */
async function getOldestUnreconciledIntentAgeByNetwork(prisma, { now = new Date() } = {}) {
  const intents = await prisma.paymentIntent.findMany({
    where: { status: { in: UNRECONCILED_STATUSES } },
    select: { id: true, network: true, submittedAt: true, createdAt: true },
  });

  const result = {};
  for (const intent of intents) {
    const submittedAt = intent.submittedAt || intent.createdAt;
    if (!submittedAt) {
      continue;
    }
    const submittedMs = new Date(submittedAt).getTime();
    if (Number.isNaN(submittedMs)) {
      continue;
    }
    const existing = result[intent.network];
    if (!existing || submittedMs < existing.oldestSubmittedAt.getTime()) {
      result[intent.network] = {
        oldestIntentId: intent.id,
        oldestSubmittedAt: new Date(submittedMs),
        ageMs: Math.max(0, now.getTime() - submittedMs),
      };
    }
  }

  return result;
}

/**
 * Records the submission-to-finality duration for an intent that has just
 * reached a terminal state. Labels are limited to `network` and `outcome`.
 *
 * @param {object} metrics - Metrics sink exposing `observeFinalityDuration(labels, ms)`
 * @param {object} params
 * @param {string} params.network
 * @param {string} params.outcome - Terminal status (COMPLETED/FAILED/CANCELLED)
 * @param {Date|string} params.submittedAt
 * @param {Date} [params.finalizedAt]
 * @returns {number|null} The recorded duration in ms, or null if not recordable
 */
function recordFinalityDuration(metrics, { network, outcome, submittedAt, finalizedAt = new Date() }) {
  if (!metrics || typeof metrics.observeFinalityDuration !== 'function') {
    return null;
  }
  if (!isTerminalStatus(outcome) || !submittedAt) {
    return null;
  }
  const submittedMs = new Date(submittedAt).getTime();
  const finalizedMs = new Date(finalizedAt).getTime();
  if (Number.isNaN(submittedMs) || Number.isNaN(finalizedMs)) {
    return null;
  }
  const durationMs = Math.max(0, finalizedMs - submittedMs);
  metrics.observeFinalityDuration({ network, outcome }, durationMs);
  return durationMs;
}

module.exports = {
  VALID_TRANSITIONS,
  ALL_STATUSES,
  UNRECONCILED_STATUSES,
  TERMINAL_STATUSES,
  isValidTransition,
  isTerminalStatus,
  assertValidTransition,
  buildGuardedWhere,
  publishStatusEvent,
  updatePaymentIntentStatus,
  updatePaymentIntentStatusTx,
  getOldestUnreconciledIntentAgeByNetwork,
  recordFinalityDuration,
};