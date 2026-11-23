'use strict';

const { asyncHandler } = require('../../middleware/asyncHandler');
const { ApiError } = require('../../errors');
const { listDLQEntries, replayFromDLQ } = require('../../webhookWorker');

// Bounds for the queue-health summary so labels stay portable across
// environments (small test fixtures and large production queues alike).
const HEALTH_MAX_ATTEMPT_BUCKETS = 10;
const HEALTH_MAX_LATENCY_SAMPLES = 500;
const HEALTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clampAgeMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), HEALTH_MAX_AGE_MS);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Build a bounded attempt-distribution histogram from raw attempt counts.
 * Buckets are labelled "1", "2", ... up to HEALTH_MAX_ATTEMPT_BUCKETS, with
 * the final bucket collapsing everything at or above the cap.
 */
function buildAttemptDistribution(attempts) {
  const buckets = [];
  for (let i = 1; i <= HEALTH_MAX_ATTEMPT_BUCKETS; i += 1) {
    buckets.push({
      label: i === HEALTH_MAX_ATTEMPT_BUCKETS ? `${i}+` : String(i),
      min: i,
      max: i === HEALTH_MAX_ATTEMPT_BUCKETS ? null : i,
      count: 0,
    });
  }
  for (const raw of attempts) {
    const n = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
    const idx = Math.min(n, HEALTH_MAX_ATTEMPT_BUCKETS) - 1;
    buckets[idx].count += 1;
  }
  return buckets;
}

function summarizeLatency(samples) {
  const bounded = samples
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice(0, HEALTH_MAX_LATENCY_SAMPLES)
    .sort((a, b) => a - b);
  if (!bounded.length) {
    return { count: 0, p50_ms: null, p95_ms: null, max_ms: null };
  }
  return {
    count: bounded.length,
    p50_ms: percentile(bounded, 50),
    p95_ms: percentile(bounded, 95),
    max_ms: bounded[bounded.length - 1],
  };
}

module.exports = (router, adminAuth, getPrisma) => {
  // ── Dead Letter Queue (DLQ) ────────────────────────────────────────────

  /**
   * GET /admin/dlq
   * List dead-letter-queue entries.  Supports optional `?username=` filter,
   * `?limit=` (default 50, max 200), and `?offset=` (default 0).
   */
  router.get(
    '/admin/dlq',
    adminAuth,
    asyncHandler(async (req, res, next) => {
      const { prisma } = getPrisma();
      const username =
        typeof req.query.username === 'string'
          ? req.query.username.trim()
          : undefined;
      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 50, 1),
        200,
      );
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      try {
        const { entries, total } = await listDLQEntries(
          prisma,
          async (sql, params) => {
            // Fallback path not used in normal operation; provide empty impl
            return [];
          },
          { username, limit, offset },
        );

        // `entries` is already bounded by `limit`; never echo more than that.
        const boundedEntries = Array.isArray(entries)
          ? entries.slice(0, limit)
          : [];

        return res.status(200).json({
          ok: true,
          total,
          limit,
          offset,
          entries: boundedEntries.map((e) => ({
            id: e.id,
            webhook_id: e.webhookId,
            webhook_url: e.webhookUrl,
            username: e.username,
            event_type: e.eventType,
            failure_reason: e.failureReason,
            delivery_attempts: e.deliveryAttempts,
            moved_at: (e.movedAt instanceof Date
              ? e.movedAt
              : new Date(e.movedAt)
            ).toISOString(),
            replayed: e.replayed,
            replayed_at: e.replayedAt
              ? (e.replayedAt instanceof Date
                  ? e.replayedAt
                  : new Date(e.replayedAt)
                ).toISOString()
              : null,
          })),
        });
      } catch (error) {
        // Degrade gracefully when Postgres/Redis is unavailable: report an
        // empty, bounded listing rather than failing the whole dashboard.
        if (
          error &&
          (error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'P1001' ||
            error.code === 'P1002' ||
            error.code === 'P1017' ||
            error.name === 'PrismaClientInitializationError' ||
            error.name === 'PrismaClientKnownRequestError')
        ) {
          return res.status(200).json({
            ok: true,
            degraded: true,
            total: 0,
            limit,
            offset,
            entries: [],
          });
        }
        return next(error);
      }
    }),
  );

  /**
   * GET /admin/dlq/health
   * Operational summary of webhook queue health:
   *   - oldest pending event age
   *   - delivery attempt distribution (bounded buckets)
   *   - delivery latency percentiles (bounded sample set)
   *   - DLQ entry age
   */
  router.get(
    '/admin/dlq/health',
    adminAuth,
    asyncHandler(async (req, res, next) => {
      const { prisma } = getPrisma();
      const now = Date.now();

      try {
        const [pendingRows, deliveredRows, dlqRows] = await Promise.all([
          prisma.webhookEvent.findMany({
            where: { status: { in: ['pending', 'retrying'] } },
            select: { createdAt: true, deliveryAttempts: true },
            orderBy: { createdAt: 'asc' },
            take: HEALTH_MAX_LATENCY_SAMPLES,
          }),
          prisma.webhookEvent.findMany({
            where: { status: 'delivered', deliveredAt: { not: null } },
            select: { createdAt: true, deliveredAt: true },
            orderBy: { deliveredAt: 'desc' },
            take: HEALTH_MAX_LATENCY_SAMPLES,
          }),
          prisma.webhookDLQ.findMany({
            where: { replayed: false },
            select: { movedAt: true },
            orderBy: { movedAt: 'asc' },
            take: HEALTH_MAX_LATENCY_SAMPLES,
          }),
        ]);

        const pending = Array.isArray(pendingRows) ? pendingRows : [];
        const delivered = Array.isArray(deliveredRows) ? deliveredRows : [];
        const dlq = Array.isArray(dlqRows) ? dlqRows : [];

        // Oldest pending event age.
        let oldestPendingAgeMs = null;
        for (const row of pending) {
          const created = toDate(row.createdAt);
          if (!created) continue;
          const age = clampAgeMs(now - created.getTime());
          if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) {
            oldestPendingAgeMs = age;
          }
        }

        // Attempt distribution across pending/retrying events.
        const attemptDistribution = buildAttemptDistribution(
          pending.map((row) => row.deliveryAttempts),
        );

        // Delivery latency (deliveredAt - createdAt).
        const latencySamples = [];
        for (const row of delivered) {
          const created = toDate(row.createdAt);
          const deliveredAt = toDate(row.deliveredAt);
          if (!created || !deliveredAt) continue;
          latencySamples.push(clampAgeMs(deliveredAt.getTime() - created.getTime()));
        }
        const deliveryLatency = summarizeLatency(latencySamples);

        // DLQ age: oldest unreplayed entry and aggregate stats.
        let oldestDlqAgeMs = null;
        let newestDlqAgeMs = null;
        for (const row of dlq) {
          const movedAt = toDate(row.movedAt);
          if (!movedAt) continue;
          const age = clampAgeMs(now - movedAt.getTime());
          if (oldestDlqAgeMs === null || age > oldestDlqAgeMs) {
            oldestDlqAgeMs = age;
          }
          if (newestDlqAgeMs === null || age < newestDlqAgeMs) {
            newestDlqAgeMs = age;
          }
        }

        return res.status(200).json({
          ok: true,
          generated_at: new Date(now).toISOString(),
          bounds: {
            max_attempt_buckets: HEALTH_MAX_ATTEMPT_BUCKETS,
            max_latency_samples: HEALTH_MAX_LATENCY_SAMPLES,
            max_age_ms: HEALTH_MAX_AGE_MS,
          },
          pending: {
            count: pending.length,
            oldest_age_ms: oldestPendingAgeMs,
          },
          attempt_distribution: attemptDistribution,
          delivery_latency: deliveryLatency,
          dlq: {
            count: dlq.length,
            oldest_age_ms: oldestDlqAgeMs,
            newest_age_ms: newestDlqAgeMs,
          },
        });
      } catch (error) {
        // Degrade gracefully when Postgres/Redis is unavailable.
        if (
          error &&
          (error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'P1001' ||
            error.code === 'P1002' ||
            error.code === 'P1017' ||
            error.name === 'PrismaClientInitializationError' ||
            error.name === 'PrismaClientKnownRequestError')
        ) {
          return res.status(200).json({
            ok: true,
            degraded: true,
            generated_at: new Date(now).toISOString(),
            bounds: {
              max_attempt_buckets: HEALTH_MAX_ATTEMPT_BUCKETS,
              max_latency_samples: HEALTH_MAX_LATENCY_SAMPLES,
              max_age_ms: HEALTH_MAX_AGE_MS,
            },
            pending: { count: 0, oldest_age_ms: null },
            attempt_distribution: buildAttemptDistribution([]),
            delivery_latency: summarizeLatency([]),
            dlq: { count: 0, oldest_age_ms: null, newest_age_ms: null },
          });
        }
        return next(error);
      }
    }),
  );

  /**
   * POST /admin/dlq/:id/replay
   * Manually replay a dead-letter-queue entry — retries delivery once.
   */
  router.post(
    '/admin/dlq/:id/replay',
    adminAuth,
    asyncHandler(async (req, res, next) => {
      const { prisma } = getPrisma();
      const id =
        typeof req.params?.id === 'string' ? req.params.id.trim() : '';

      if (!id) {
        return next(new ApiError('INVALID_INPUT', 'DLQ entry id is required in URL path.'));
      }

      try {
        const result = await replayFromDLQ(prisma, async (sql, params) => [], id);

        if (!result.ok) {
          const code = result.error === 'DLQ entry not found' ? 'NOT_FOUND' : 'CONFLICT';
          return next(new ApiError(code, result.error));
        }

        return res.status(200).json({ ok: true, replayed: true });
      } catch (error) {
        return next(error);
      }
    }),
  );

};
