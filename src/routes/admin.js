const express = require('express');
const router = express.Router();
const { maskIp } = require('../utils');
const { AuditLog, WebhookEvent } = require('../models');

// GET /admin/audit-logs
router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await AuditLog.findAll({
      order: [['createdAt', 'DESC']],
    });

    const maskedLogs = logs.map((log) => {
      const plain = log.get({ plain: true });
      return {
        ...plain,
        ipAddress: maskIp(plain.ipAddress),
      };
    });

    res.json(maskedLogs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Bounded attempt-distribution buckets for dashboard/alerting use.
const ATTEMPT_BUCKETS = [
  { label: '0', min: 0, max: 0 },
  { label: '1', min: 1, max: 1 },
  { label: '2-3', min: 2, max: 3 },
  { label: '4-5', min: 4, max: 5 },
  { label: '6-10', min: 6, max: 10 },
  { label: '11+', min: 11, max: Infinity },
];

// Bounded latency buckets (milliseconds) for delivery latency summary.
const LATENCY_BUCKETS = [
  { label: '<1s', min: 0, max: 1000 },
  { label: '1-5s', min: 1000, max: 5000 },
  { label: '5-30s', min: 5000, max: 30000 },
  { label: '30s-5m', min: 30000, max: 300000 },
  { label: '5m+', min: 300000, max: Infinity },
];

function toMillis(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ageMs(from, now) {
  const ms = toMillis(from);
  if (ms === null) return null;
  return Math.max(0, now - ms);
}

function bucketCounts(values, buckets) {
  const counts = buckets.map((b) => ({ label: b.label, count: 0 }));
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      if (value >= b.min && value <= b.max) {
        counts[i].count += 1;
        break;
      }
    }
  }
  return counts;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// GET /admin/webhook-queue/health
router.get('/webhook-queue/health', async (req, res) => {
  try {
    const now = Date.now();

    const events = await WebhookEvent.findAll({
      attributes: [
        'id',
        'status',
        'attempts',
        'createdAt',
        'updatedAt',
        'deliveredAt',
        'nextAttemptAt',
      ],
      raw: true,
    });

    const pending = [];
    const delivered = [];
    const deadLettered = [];

    for (const event of events) {
      const status = event.status;
      if (status === 'delivered' || status === 'succeeded') {
        delivered.push(event);
      } else if (status === 'dead_letter' || status === 'dead-lettered' || status === 'dlq' || status === 'failed_permanently') {
        deadLettered.push(event);
      } else {
        pending.push(event);
      }
    }

    // Oldest pending event age.
    let oldestPendingAgeMs = null;
    for (const event of pending) {
      const age = ageMs(event.createdAt, now);
      if (age !== null && (oldestPendingAgeMs === null || age > oldestPendingAgeMs)) {
        oldestPendingAgeMs = age;
      }
    }

    // Attempt distribution across all events.
    const attemptValues = events
      .map((e) => (Number.isFinite(Number(e.attempts)) ? Number(e.attempts) : 0));
    const attemptDistribution = bucketCounts(attemptValues, ATTEMPT_BUCKETS);

    // Delivery latency summary for delivered events.
    const latencies = [];
    for (const event of delivered) {
      const created = toMillis(event.createdAt);
      const deliveredAt = toMillis(event.deliveredAt) ?? toMillis(event.updatedAt);
      if (created !== null && deliveredAt !== null && deliveredAt >= created) {
        latencies.push(deliveredAt - created);
      }
    }
    latencies.sort((a, b) => a - b);
    const latencySummary = {
      count: latencies.length,
      minMs: latencies.length ? latencies[0] : null,
      maxMs: latencies.length ? latencies[latencies.length - 1] : null,
      avgMs: latencies.length
        ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
        : null,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99),
      buckets: bucketCounts(latencies, LATENCY_BUCKETS),
    };

    // DLQ age: oldest dead-lettered event age.
    let oldestDlqAgeMs = null;
    for (const event of deadLettered) {
      const age = ageMs(event.createdAt, now);
      if (age !== null && (oldestDlqAgeMs === null || age > oldestDlqAgeMs)) {
        oldestDlqAgeMs = age;
      }
    }

    res.json({
      generatedAt: new Date(now).toISOString(),
      totals: {
        pending: pending.length,
        delivered: delivered.length,
        deadLettered: deadLettered.length,
        total: events.length,
      },
      oldestPendingAgeMs,
      attemptDistribution,
      deliveryLatency: latencySummary,
      dlq: {
        count: deadLettered.length,
        oldestAgeMs: oldestDlqAgeMs,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute webhook queue health' });
  }
});

module.exports = router;