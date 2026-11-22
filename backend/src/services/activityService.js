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
 * Current schema version for persisted activity event metadata. Bump this
 * whenever the metadata shape changes in a backward-incompatible way and add
 * a corresponding entry to METADATA_MIGRATIONS.
 */
const CURRENT_METADATA_VERSION = 1;

/**
 * Key under which the schema version is stored inside the persisted metadata
 * JSON. Kept inside the JSON blob so no migration of the activity_log table is
 * required and historical rows remain readable.
 */
const METADATA_VERSION_KEY = 'schemaVersion';

/**
 * Adapters that upgrade historical (unversioned or older) metadata to the
 * current schema. Each entry receives metadata at version N and returns
 * metadata at version N + 1. Unversioned rows are treated as version 0.
 *
 * @type {Record<number, (metadata: Object) => Object>}
 */
const METADATA_MIGRATIONS = {
  // v0 -> v1: unversioned rows simply gain an explicit schemaVersion.
  0: (metadata) => ({ ...metadata }),
};

/**
 * Validate metadata against the current schema. Throws on invalid input so
 * persistence boundaries fail fast rather than storing corrupt payloads.
 *
 * @param {Object} metadata
 * @returns {Object} the validated metadata
 */
function validateMetadata(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('activity metadata must be a plain object');
  }

  const version = metadata[METADATA_VERSION_KEY];
  if (version !== CURRENT_METADATA_VERSION) {
    throw new RangeError(
      `activity metadata schemaVersion must be ${CURRENT_METADATA_VERSION}, got ${version}`
    );
  }

  return metadata;
}

/**
 * Upgrade historical metadata (unversioned or older versions) to the current
 * schema version. Unknown future versions are rejected: we cannot safely
 * downgrade data written by a newer writer, so callers must handle them.
 *
 * @param {Object|null|undefined} metadata
 * @returns {Object} metadata at CURRENT_METADATA_VERSION
 */
function upgradeMetadata(metadata) {
  if (metadata === null || metadata === undefined) {
    metadata = {};
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('activity metadata must be a plain object');
  }

  let current = { ...metadata };
  let version = Number.isInteger(current[METADATA_VERSION_KEY])
    ? current[METADATA_VERSION_KEY]
    : 0;

  if (version > CURRENT_METADATA_VERSION) {
    throw new RangeError(
      `activity metadata schemaVersion ${version} is newer than supported ${CURRENT_METADATA_VERSION}`
    );
  }

  while (version < CURRENT_METADATA_VERSION) {
    const migrate = METADATA_MIGRATIONS[version];
    if (!migrate) {
      throw new RangeError(`no migration registered for activity metadata version ${version}`);
    }
    current = migrate(current);
    version += 1;
    current[METADATA_VERSION_KEY] = version;
  }

  return current;
}

/**
 * Prepare metadata for persistence: upgrade historical shapes and stamp the
 * current schema version, then validate. Returns undefined when no metadata
 * was supplied so the column stays null.
 *
 * @param {Object|null|undefined} metadata
 * @returns {Object|undefined}
 */
function prepareMetadataForWrite(metadata) {
  if (metadata === null || metadata === undefined) {
    return undefined;
  }
  const upgraded = upgradeMetadata(metadata);
  upgraded[METADATA_VERSION_KEY] = CURRENT_METADATA_VERSION;
  return validateMetadata(upgraded);
}

/**
 * Prepare metadata read from persistence: upgrade historical rows to the
 * current schema. Unknown future versions are surfaced as-is (with a warning)
 * so readers do not crash on data written by a newer deployment; retention
 * logic treats them as opaque and never rewrites them.
 *
 * @param {Object|null|undefined} metadata
 * @returns {Object|null|undefined}
 */
function prepareMetadataForRead(metadata) {
  if (metadata === null || metadata === undefined) {
    return metadata;
  }
  try {
    return upgradeMetadata(metadata);
  } catch (err) {
    if (err instanceof RangeError) {
      // Unknown future version: retain the row untouched for forward compat.
      return metadata;
    }
    throw err;
  }
}

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
      metadata: prepareMetadataForWrite(event.metadata),
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
      metadata: prepareMetadataForWrite(event.metadata),
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
      data: data.map((row) => ({ ...row, metadata: prepareMetadataForRead(row.metadata) })),
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
    data: data.map((row) => ({ ...row, metadata: prepareMetadataForRead(row.metadata) })),
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

/* … truncated 4010 chars — edit only what you need near the top … */
