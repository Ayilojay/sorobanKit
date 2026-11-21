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
 * Action recorded when an operator applies a payment data repair. Used to
 * detect already-applied repairs so re-runs stay idempotent.
 */
const PAYMENT_REPAIR_ACTION = 'payment.repair.applied';

/**
 * Default maximum number of payment records examined per repair run.
 */
const DEFAULT_REPAIR_BATCH_SIZE = 200;

/**
 * Hard upper bound on the repair batch size, regardless of caller input.
 */
const MAX_REPAIR_BATCH_SIZE = 2000;

/**
 * Build a stable, deterministic key for a repair proposal so the same
 * underlying defect always maps to the same key across runs. This is what
 * makes resumption idempotent: an applied repair is recorded under this key
 * and skipped on subsequent runs.
 *
 * @param {Object} payment
 * @returns {string}
 */
function repairKeyFor(payment) {
  return `payment:${payment.id}:amount`;
}

/**
 * Determine whether a payment record needs an amount repair. A record is
 * considered defective when its stored amount is missing, non-numeric, or
 * negative. The proposed value is the absolute, rounded amount.
 *
 * @param {Object} payment
 * @returns {{ needsRepair: boolean, before: any, after: any }}
 */
function proposeRepair(payment) {
  const before = payment.amount;
  const numeric = Number(before);

  if (before === null || before === undefined || Number.isNaN(numeric)) {
    return { needsRepair: true, before, after: 0 };
  }

  if (numeric < 0) {
    return { needsRepair: true, before, after: Math.abs(numeric) };
  }

  return { needsRepair: false, before, after: numeric };
}

/**
 * Operator CLI for repairing payment data.
 *
 * Safety model:
 * - Dry-run by default: with `apply` falsy the command only *proposes*
 *   repairs and never mutates payment rows.
 * - Explicit apply: mutations happen only when `apply === true`.
 * - Evidence: every proposal records `before`/`after` values, and applied
 *   repairs are persisted as activity log entries carrying the same evidence.
 * - Resumable & idempotent: each repair is keyed deterministically and applied
 *   repairs are recorded under `PAYMENT_REPAIR_ACTION`. Re-running after an
 *   interruption skips already-applied keys, so unsafe side effects are never
 *   repeated. `resumeFrom` lets an operator continue after a known key.
 *
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] mutate data only when true
 * @param {number} [options.batchSize=DEFAULT_REPAIR_BATCH_SIZE]
 * @param {string} [options.resumeFrom] last processed repair key
 * @param {string} [options.operatorId] user id attributed to applied repairs
 * @returns {Promise<{ applied: boolean, proposals: Object[], appliedCount: number, skippedCount: number, resumedFrom: string|null }>}
 */
async function repairPaymentData(options = {}) {
  const apply = options.apply === true;
  const requestedBatch = Number.parseInt(options.batchSize, 10);
  const batchSize = Math.min(
    MAX_REPAIR_BATCH_SIZE,
    Math.max(1, requestedBatch || DEFAULT_REPAIR_BATCH_SIZE)
  );
  const resumeFrom = options.resumeFrom || null;

  const payments = await prisma.payment.findMany({
    orderBy: { id: 'asc' },
    take: batchSize,
    select: { id: true, amount: true },
  });

  // Load already-applied repair keys so re-runs skip completed work.
  const appliedLogs = await prisma.activityLog.findMany({
    where: { action: PAYMENT_REPAIR_ACTION },
    select: { entityId: true },
  });
  const appliedKeys = new Set(appliedLogs.map((row) => row.entityId));

  const proposals = [];
  let appliedCount = 0;
  let skippedCount = 0;
  let resuming = resumeFrom === null;

  for (const payment of payments) {
    const key = repairKeyFor(payment);

    // Resume support: skip everything up to and including the resume key.
    if (!resuming) {
      if (key === resumeFrom) {
        resuming = true;
      }
      continue;
    }

    const { needsRepair, before, after } = proposeRepair(payment);
    if (!needsRepair) {
      continue;
    }

    // Idempotency: never re-apply a repair that was already recorded.
    if (appliedKeys.has(key)) {
      skippedCount += 1;
      continue;
    }

    const proposal = { key, paymentId: payment.id, before, after };
    proposals.push(proposal);

    if (apply) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { amount: after },
      });

      await log({
        userId: options.operatorId || 'system',
        action: PAYMENT_REPAIR_ACTION,
        entityType: 'payment',
        entityId: key,
        metadata: { paymentId: payment.id, before, after },
      });

      appliedKeys.add(key);
      appliedCount += 1;
    }
  }

  return {
    applied: apply,
    proposals,
    appliedCount,
    skippedCount,
    resumedFrom: resumeFrom,
  };
}

module.exports = {
  log,
  logMany,
  listByUser,
  cleanupCompletedRecords,
  repairPaymentData,
  proposeRepair,
  repairKeyFor,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CLEANUP_BATCH_SIZE,
  MAX_CLEANUP_BATCH_SIZE,
  CLEANUP_ELIGIBLE_ACTIONS,
  CLEANUP_PROTECTED_ACTIONS,
  PAYMENT_REPAIR_ACTION,
  DEFAULT_REPAIR_BATCH_SIZE,
  MAX_REPAIR_BATCH_SIZE,
};
