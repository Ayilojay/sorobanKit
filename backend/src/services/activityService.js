const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * @typedef {Object} ActivityEvent
 * @property {string} userId
 * @property {string} action
 * @property {string} [entityType]
 * @property {string} [entityId]
 * @property {Object} [metadata]
 */

/**
 * Persist a single activity log entry.
 * @param {ActivityEvent} event
 * @returns {Promise<Object>}
 */
async function log(event) {
  return prisma.activityLog.create({
    data: {
      userId: event.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
    },
  });
}

/**
 * Persist multiple activity log entries in a single Prisma call.
 * @param {ActivityEvent[]} events
 * @returns {Promise<{ count: number }>}
 */
async function logMany(events) {
  if (!Array.isArray(events) || events.length === 0) {
  return { count: 0 };
  }

  return prisma.activityLog.createMany({
    data: events.map((event) => ({
      userId: event.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
    })),
    skipDuplicates: false,
  });
}

/**
 * Fetch a page of activity logs for a user.
 *
 * Supports two pagination strategies:
 * - Cursor-based (preferred for large, time-ordered tables): pass `cursor`
 *   (the last seen `id`) to fetch the next page after that ID. This avoids
 *   the large `skip` scans that make deep offset pagination slow.
 * - Offset-based (backward compatible): used when no `cursor` is provided.
 *
 * @param {string} userId
 * @param {Object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {string} [options.cursor] last seen activity log id
 * @returns {Promise<{ data: Object[], total: number, page: number, limit: number, totalPages: number, nextCursor: string|null }>}
 */
async function listByUser(userId, options = {}) {
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
  const cursor = options.cursor || null;

  const where = { userId };

  if (cursor) {
    // Cursor-based pagination: fetch the page after the given id.
    const rows = await prisma.activityLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      cursor: { id: cursor },
      skip: 1,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    const total = await prisma.activityLog.count({ where });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      nextCursor,
    };
  }

  // Offset-based pagination: retained for clients without a cursor.
  const [data, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.activityLog.count({ where }),
  ]);

  const nextCursor = data.length === limit ? data[data.length - 1].id : null;

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    nextCursor,
  };
}

/**
 * Default retention window (in days) for completed timelock and accounting
 * records. Records younger than this are kept for audit purposes.
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Default maximum number of records removed in a single cleanup run. Cleanup
 * is always bounded so a single invocation cannot delete an unbounded set.
 */
const DEFAULT_CLEANUP_BATCH_SIZE = 500;

/**
 * Hard upper bound on the batch size accepted by cleanup, regardless of what
 * the caller requests. Prevents accidental unbounded deletes.
 */
const MAX_CLEANUP_BATCH_SIZE = 5000;

/**
 * Actions that represent completed timelock / accounting records eligible for
 * cleanup. Only these action types are ever considered for deletion.
 */
const CLEANUP_ELIGIBLE_ACTIONS = [
  'timelock.completed',
  'timelock.released',
  'accounting.settled',
  'accounting.reconciled',
];

/**
 * Actions that must never be removed by cleanup because they represent
 * pending work or outstanding refunds.
 */
const CLEANUP_PROTECTED_ACTIONS = [
  'timelock.pending',
  'timelock.scheduled',
  'refund.pending',
  'refund.outstanding',
];

/**
 * Bound cleanup of completed timelock and accounting records.
 *
 * Deletes at most `batchSize` eligible activity records that are older than
 * `retentionDays`. The operation is:
 * - Bounded: never deletes more than `batchSize` rows per call.
 * - Audit-preserving: only records older than the retention window qualify.
 * - Dispute-safe: records flagged as disputed (via metadata) are skipped.
 * - Pending-safe: pending actions and outstanding refunds are never eligible.
 * - Idempotent: re-running simply deletes whatever still qualifies (or
 *   nothing), with no duplicate or incorrect side effects.
 *
 * @param {Object} [options]
 * @param {number} [options.retentionDays=DEFAULT_RETENTION_DAYS]
 * @param {number} [options.batchSize=DEFAULT_CLEANUP_BATCH_SIZE]
 * @param {Date} [options.now=new Date()] reference time (injectable for tests)
 * @returns {Promise<{ deleted: number, cutoff: Date, batchSize: number }>}
 */
async function cleanupCompletedRecords(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();

  const retentionDays = Math.max(
    0,
    Number.parseInt(options.retentionDays, 10) || DEFAULT_RETENTION_DAYS
  );

  const requestedBatch = Number.parseInt(options.batchSize, 10);
  const batchSize = Math.min(
    MAX_CLEANUP_BATCH_SIZE,
    Math.max(1, requestedBatch || DEFAULT_CLEANUP_BATCH_SIZE)
  );

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Select a bounded set of eligible ids first so the delete is deterministic
  // and cannot exceed the batch size even if new rows appear concurrently.
  const candidates = await prisma.activityLog.findMany({
    where: {
      action: { in: CLEANUP_ELIGIBLE_ACTIONS },
      createdAt: { lt: cutoff },
      NOT: { action: { in: CLEANUP_PROTECTED_ACTIONS } },
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true, metadata: true },
  });

  // Skip records still needed for open disputes (metadata.disputed === true).
  const ids = candidates
    .filter((row) => !(row.metadata && row.metadata.disputed === true))
    .map((row) => row.id);

  if (ids.length === 0) {
    return { deleted: 0, cutoff, batchSize };
  }

  const result = await prisma.activityLog.deleteMany({
    where: {
      id: { in: ids },
      action: { in: CLEANUP_ELIGIBLE_ACTIONS },
      createdAt: { lt: cutoff },
      NOT: { action: { in: CLEANUP_PROTECTED_ACTIONS } },
    },
  });

  return { deleted: result.count, cutoff, batchSize };
}

/**
 * In-memory reporting read model for aggregate activity statistics.
 *
 * Aggregates are computed from the source `activityLog` table and cached here
 * so reporting reads never run heavy GROUP BY scans inline against the write
 * path. Each refresh records a source watermark (the highest activity log id
 * observed) and a refresh status so consumers can reason about staleness.
 *
 * @typedef {Object} ReportingReadModel
 * @property {Object|null} aggregates
 * @property {string|null} watermark
 * @property {'idle'|'refreshing'|'ready'|'failed'} status
 * @property {Date|null} refreshedAt
 * @property {string|null} error
 */
const reportingReadModel = {
  aggregates: null,
  watermark: null,
  status: 'idle',
  refreshedAt: null,
  error: null,
};

/**
 * Compute aggregate activity statistics directly from the source table.
 *
 * This is the source-of-truth query used both to build the read model and to
 * prove correctness of the cached aggregates.
 *
 * @returns {Promise<{ total: number, byAction: Object, watermark: string|null }>}
 */
async function computeSourceAggregates() {
  const [total, grouped, latest] = await Promise.all([
    prisma.activityLog.count(),
    prisma.activityLog.groupBy({
      by: ['action'],
      _count: { _all: true },
    }),
    prisma.activityLog.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    }),
  ]);

  const byAction = {};
  for (const row of grouped) {
    byAction[row.action] = row._count._all;
  }

  return {
    total,
    byAction,
    watermark: latest ? latest.id : null,
  };
}

/**
 * Refresh the reporting read model from the source table.
 *
 * Runs the aggregation off the payment write path and atomically swaps the
 * cached aggregates once the source query completes. Concurrent refreshes are
 * coalesced: if a refresh is already in flight the in-flight promise is
 * returned instead of starting a second scan.
 *
 * @returns {Promise<ReportingReadModel>}
 */
let inFlightRefresh = null;

async function refreshReportingReadModel() {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  reportingReadModel.status = 'refreshing';
  reportingReadModel.error = null;

  inFlightRefresh = (async () => {
    try {
      const source = await computeSourceAggregates();
      reportingReadModel.aggregates = {
        total: source.total,
        byAction: source.byAction,
      };
      reportingReadModel.watermark = source.watermark;
      reportingReadModel.refreshedAt = new Date();
      reportingReadModel.status = 'ready';
    } catch (err) {
      reportingReadModel.status = 'failed';
      reportingReadModel.error = err && err.message ? err.message : String(err);
    } finally {
      inFlightRefresh = null;
    }

    return getReportingStatus();
  })();

  return inFlightRefresh;
}

/**
 * Read the current reporting read model status and aggregates.
 *
 * @returns {{ status: string, watermark: string|null, refreshedAt: Date|null, error: string|null, aggregates: Object|null }}
 */
function getReportingStatus() {
  return {
    status: reportingReadModel.status,
    watermark: reportingReadModel.watermark,
    refreshedAt: reportingReadModel.refreshedAt,
    error: reportingReadModel.error,
    aggregates: reportingReadModel.aggregates,
  };
}

/**
 * Verify the cached read model aggregates against a fresh source query.
 *
 * @returns {Promise<{ matches: boolean, source: Object, cached: Object|null, watermark: string|null }>}
 */
async function verifyReportingReadModel() {
  const source = await computeSourceAggregates();
  const cached = reportingReadModel.aggregates;

  const matches =
    cached !== null &&
    cached.total === source.total &&
    JSON.stringify(cached.byAction) === JSON.stringify(source.byAction);

  return {
    matches,
    source: { total: source.total, byAction: source.byAction },
    cached,
    watermark: source.watermark,
  };
}

module.exports = {
  log,
  logMany,
  listByUser,
  cleanupCompletedRecords,
  computeSourceAggregates,
  refreshReportingReadModel,
  getReportingStatus,
  verifyReportingReadModel,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CLEANUP_BATCH_SIZE,
  MAX_CLEANUP_BATCH_SIZE,
  CLEANUP_ELIGIBLE_ACTIONS,
  CLEANUP_PROTECTED_ACTIONS,
};
