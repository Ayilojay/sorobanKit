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
 * Actions that represent durable liability records reconciled by the report.
 * Each entry maps an action to the liability category it contributes to.
 */
const RECONCILIATION_LIABILITY_ACTIONS = {
  'payment.recorded': 'payment',
  'payment.settled': 'payment',
  'fee.charged': 'fee',
  'fee.accrued': 'fee',
  'refund.issued': 'refund',
  'refund.completed': 'refund',
};

/**
 * Hard upper bound on the number of durable records scanned by a single
 * reconciliation run. Keeps the read-only report bounded.
 */
const MAX_RECONCILIATION_RECORDS = 10000;

/**
 * Build a read-only reconciliation report of payment, fee, and refund
 * liabilities from durable activity records.
 *
 * The report is grouped by `network` and `asset` (read from record metadata)
 * and bounded to the inclusive `[from, to]` date range. It surfaces:
 * - missing records: liability references (metadata.reference) that appear in
 *   one category but are absent from a category they should accompany.
 * - duplicated records: the same reference recorded more than once within a
 *   category.
 * - inconsistent records: records missing required metadata (network, asset,
 *   amount, reference) or with a non-positive amount.
 *
 * The operation is strictly read-only and deterministic for a given set of
 * durable records.
 *
 * @param {Object} options
 * @param {Date|string} options.from inclusive lower bound (required)
 * @param {Date|string} options.to inclusive upper bound (required)
 * @param {number} [options.limit=MAX_RECONCILIATION_RECORDS]
 * @returns {Promise<Object>} reconciliation report
 */
async function reconcileLiabilities(options = {}) {
  const from = options.from instanceof Date ? options.from : new Date(options.from);
  const to = options.to instanceof Date ? options.to : new Date(options.to);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('reconcileLiabilities requires valid `from` and `to` dates');
  }
  if (from.getTime() > to.getTime()) {
    throw new Error('reconcileLiabilities requires `from` <= `to`');
  }

  const requestedLimit = Number.parseInt(options.limit, 10);
  const limit = Math.min(
    MAX_RECONCILIATION_RECORDS,
    Math.max(1, requestedLimit || MAX_RECONCILIATION_RECORDS)
  );

  const actions = Object.keys(RECONCILIATION_LIABILITY_ACTIONS);

  const records = await prisma.activityLog.findMany({
    where: {
      action: { in: actions },
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, action: true, entityId: true, metadata: true, createdAt: true },
  });

  const groups = new Map();
  const inconsistent = [];
  const referencesByCategory = { payment: new Map(), fee: new Map(), refund: new Map() };

  for (const record of records) {
    const category = RECONCILIATION_LIABILITY_ACTIONS[record.action];
    const meta = record.metadata || {};
    const network = meta.network;
    const asset = meta.asset;
    const reference = meta.reference || record.entityId;
    const amount = Number(meta.amount);

    const problems = [];
    if (!network) problems.push('missing network');
    if (!asset) problems.push('missing asset');
    if (!reference) problems.push('missing reference');
    if (!Number.isFinite(amount) || amount <= 0) problems.push('invalid amount');

    if (problems.length > 0) {
      inconsistent.push({
        id: record.id,
        action: record.action,
        category,
        reference: reference || null,
        problems,
      });
      continue;
    }

    const groupKey = `${network}::${asset}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        network,
        asset,
        totals: { payment: 0, fee: 0, refund: 0 },
        counts: { payment: 0, fee: 0, refund: 0 },
      });
    }
    const group = groups.get(groupKey);
    group.totals[category] += amount;
    group.counts[category] += 1;

    if (!referencesByCategory[category].has(reference)) {
      referencesByCategory[category].set(reference, []);
    }
    referencesByCategory[category].get(reference).push(record.id);
  }

  // Duplicated records: same reference recorded more than once in a category.
  const duplicated = [];
  for (const category of Object.keys(referencesByCategory)) {
    for (const [reference, ids] of referencesByCategory[category].entries()) {
      if (ids.length > 1) {
        duplicated.push({ category, reference, ids });
      }
    }
  }

  // Missing records: a reference present in one category but absent from a
  // category it should accompany (payments should have matching fees/refunds
  // when the reference is shared across categories).
  const missing = [];
  const allReferences = new Set();
  for (const category of Object.keys(referencesByCategory)) {
    for (const reference of referencesByCategory[category].keys()) {
      allReferences.add(reference);
    }
  }
  for (const reference of allReferences) {
    const present = Object.keys(referencesByCategory).filter((category) =>
      referencesByCategory[category].has(reference)
    );
    if (present.length > 1) {
      for (const category of Object.keys(referencesByCategory)) {
        if (!referencesByCategory[category].has(reference)) {
          missing.push({ reference, expectedCategory: category, presentIn: present });
        }
      }
    }
  }

  const byNetworkAsset = Array.from(groups.values()).sort((a, b) => {
    if (a.network !== b.network) return a.network < b.network ? -1 : 1;
    if (a.asset !== b.asset) return a.asset < b.asset ? -1 : 1;
    return 0;
  });

  return {
    from,
    to,
    recordCount: records.length,
    truncated: records.length >= limit,
    byNetworkAsset,
    missing,
    duplicated,
    inconsistent,
  };
}

module.exports = {
  log,
  logMany,
  listByUser,
  cleanupCompletedRecords,
  reconcileLiabilities,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CLEANUP_BATCH_SIZE,
  MAX_CLEANUP_BATCH_SIZE,
  CLEANUP_ELIGIBLE_ACTIONS,
  CLEANUP_PROTECTED_ACTIONS,
  RECONCILIATION_LIABILITY_ACTIONS,
  MAX_RECONCILIATION_RECORDS,
};
