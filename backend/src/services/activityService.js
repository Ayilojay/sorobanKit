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
 * Supported activity-log ledger state versions. Each version maps to the
 * shape of the `activityLog` records that version produced. Snapshots whose
 * `stateVersion` is not listed here are rejected before any mutation.
 */
const SUPPORTED_STATE_VERSIONS = ['1.0.0', '1.1.0', '2.0.0'];

/**
 * Candidate migrations keyed by the state version they upgrade FROM. Each
 * migration is a pure function that receives a snapshot record and returns
 * the upgraded record (or throws if the record is malformed).
 */
const ACTIVITY_MIGRATIONS = {
  '1.0.0': (record) => ({
    ...record,
    metadata: record.metadata || {},
    entityType: record.entityType || null,
    entityId: record.entityId || null,
  }),
  '1.1.0': (record) => ({
    ...record,
    metadata: record.metadata || {},
  }),
};

/**
 * Invariant checks run against a migrated snapshot. Each check returns true
 * when the invariant holds. A failing check aborts the simulation.
 */
const ACTIVITY_INVARIANTS = [
  {
    name: 'userId is a non-empty string',
    check: (record) => typeof record.userId === 'string' && record.userId.length > 0,
  },
  {
    name: 'action is a non-empty string',
    check: (record) => typeof record.action === 'string' && record.action.length > 0,
  },
  {
    name: 'metadata is an object when present',
    check: (record) =>
      record.metadata === undefined ||
      record.metadata === null ||
      (typeof record.metadata === 'object' && !Array.isArray(record.metadata)),
  },
];

/**
 * Validate that a snapshot has a supported layout before any mutation.
 * @param {Object} snapshot
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, reason: 'snapshot must be an object' };
  }
  if (!SUPPORTED_STATE_VERSIONS.includes(snapshot.stateVersion)) {
    return {
      ok: false,
      reason: `unsupported stateVersion: ${String(snapshot.stateVersion)}`,
    };
  }
  if (!Array.isArray(snapshot.records)) {
    return { ok: false, reason: 'snapshot.records must be an array' };
  }
  return { ok: true };
}

/**
 * Apply candidate migrations to a single snapshot record, walking forward
 * through each supported version until the latest is reached.
 * @param {Object} record
 * @param {string} fromVersion
 * @returns {Object}
 */
function migrateRecord(record, fromVersion) {
  let current = { ...record };
  let version = fromVersion;
  const latest = SUPPORTED_STATE_VERSIONS[SUPPORTED_STATE_VERSIONS.length - 1];

  while (version !== latest) {
    const migration = ACTIVITY_MIGRATIONS[version];
    if (!migration) {
      throw new Error(`no migration path from stateVersion ${version}`);
    }
    current = migration(current);
    const idx = SUPPORTED_STATE_VERSIONS.indexOf(version);
    version = SUPPORTED_STATE_VERSIONS[idx + 1];
  }

  return current;
}

/**
 * Simulate a contract upgrade against a representative ledger snapshot.
 *
 * The simulation:
 * - Rejects unsupported snapshot layouts / state versions BEFORE mutation.
 * - Applies candidate migrations to every record in the snapshot.
 * - Runs critical reads and invariant checks on the migrated records.
 * - Never touches the live database; operates purely on the supplied snapshot.
 *
 * @param {Object} snapshot
 * @param {string} snapshot.stateVersion
 * @param {Object[]} snapshot.records
 * @returns {Promise<{ ok: boolean, stateVersion: string, migrated: Object[], checks: Object[], reason?: string }>}
 */
async function simulateUpgrade(snapshot) {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    return {
      ok: false,
      stateVersion: snapshot && snapshot.stateVersion,
      migrated: [],
      checks: [],
      reason: validation.reason,
    };
  }

  const migrated = [];
  const checks = [];

  for (const record of snapshot.records) {
    let upgraded;
    try {
      upgraded = migrateRecord(record, snapshot.stateVersion);
    } catch (err) {
      return {
        ok: false,
        stateVersion: snapshot.stateVersion,
        migrated,
        checks,
        reason: err.message,
      };
    }

    for (const invariant of ACTIVITY_INVARIANTS) {
      const passed = invariant.check(upgraded);
      checks.push({ name: invariant.name, passed });
      if (!passed) {
        return {
          ok: false,
          stateVersion: snapshot.stateVersion,
          migrated,
          checks,
          reason: `invariant failed: ${invariant.name}`,
        };
      }
    }

    migrated.push(upgraded);
  }

  return {
    ok: true,
    stateVersion: snapshot.stateVersion,
    migrated,
    checks,
  };
}

module.exports = {
  log,
  logMany,
  listByUser,
  cleanupCompletedRecords,
  simulateUpgrade,
  validateSnapshot,
  migrateRecord,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CLEANUP_BATCH_SIZE,
  MAX_CLEANUP_BATCH_SIZE,
  CLEANUP_ELIGIBLE_ACTIONS,
  CLEANUP_PROTECTED_ACTIONS,
  SUPPORTED_STATE_VERSIONS,
  ACTIVITY_MIGRATIONS,
  ACTIVITY_INVARIANTS,
};
