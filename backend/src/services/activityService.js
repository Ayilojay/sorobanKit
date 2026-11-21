const crypto = require('crypto');
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
 * Action recorded for every successful routed payment receipt.
 */
const PAYMENT_RECEIPT_ACTION = 'payment.receipt';

/**
 * Canonical field order for a payment receipt. The order is fixed so the
 * serialized payload (and therefore its hash) is deterministic across
 * processes, platforms, and runs.
 */
const RECEIPT_FIELDS = [
  'sender',
  'recipient',
  'token',
  'amount',
  'fee',
  'correlationId',
];

/**
 * Normalize a receipt field to a stable string form. Amounts and fees are
 * normalized to strings so numeric formatting differences (e.g. 1 vs 1.0)
 * cannot change the resulting hash.
 * @param {*} value
 * @returns {string}
 */
function normalizeReceiptValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * Build a deterministic, verifiable receipt for a successful routed payment.
 *
 * The receipt contains the sender, recipient, token, amount, fee, and
 * correlation ID. Its `hash` is the SHA-256 of the canonical JSON encoding of
 * those fields in a fixed order, so the same inputs always produce the same
 * hash and any tampering is detectable by recomputing it.
 *
 * @param {Object} payment
 * @param {string} payment.sender
 * @param {string} payment.recipient
 * @param {string} payment.token
 * @param {string|number} payment.amount
 * @param {string|number} payment.fee
 * @param {string} payment.correlationId
 * @returns {{ sender: string, recipient: string, token: string, amount: string, fee: string, correlationId: string, hash: string }}
 */
function buildPaymentReceipt(payment) {
  if (!payment || typeof payment !== 'object') {
    throw new TypeError('payment is required to build a receipt');
  }

  const receipt = {};
  for (const field of RECEIPT_FIELDS) {
    receipt[field] = normalizeReceiptValue(payment[field]);
  }

  const canonical = JSON.stringify(RECEIPT_FIELDS.map((field) => receipt[field]));
  receipt.hash = crypto.createHash('sha256').update(canonical).digest('hex');

  return receipt;
}

/**
 * Verify that a receipt's hash matches its contents.
 * @param {Object} receipt
 * @returns {boolean}
 */
function verifyPaymentReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.hash !== 'string') {
    return false;
  }

  const expected = buildPaymentReceipt(receipt);
  return expected.hash === receipt.hash;
}

/**
 * Emit exactly one receipt for a successful routed payment.
 *
 * The receipt is persisted as a single activity log entry. Callers must only
 * invoke this on success; on failure no receipt is emitted. The returned
 * receipt is the same deterministic object that was persisted, so integration
 * tests can decode and verify it.
 *
 * @param {Object} payment see {@link buildPaymentReceipt}
 * @param {Object} [options]
 * @param {string} [options.userId] owner of the activity entry (defaults to sender)
 * @returns {Promise<Object>} the persisted receipt
 */
async function emitPaymentReceipt(payment, options = {}) {
  const receipt = buildPaymentReceipt(payment);

  await log({
    userId: options.userId || receipt.sender,
    action: PAYMENT_RECEIPT_ACTION,
    entityType: 'payment',
    entityId: receipt.correlationId,
    metadata: receipt,
  });

  return receipt;
}

module.exports = {
  log,
  logMany,
  listByUser,
  cleanupCompletedRecords,
  buildPaymentReceipt,
  verifyPaymentReceipt,
  emitPaymentReceipt,
  PAYMENT_RECEIPT_ACTION,
  RECEIPT_FIELDS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CLEANUP_BATCH_SIZE,
  MAX_CLEANUP_BATCH_SIZE,
  CLEANUP_ELIGIBLE_ACTIONS,
  CLEANUP_PROTECTED_ACTIONS,
};
