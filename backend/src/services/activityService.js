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
 * Time-based partitioning helpers for high-volume history tables.
 *
 * Payment and webhook history grow without bound and are almost always queried
 * by recency. Partitioning them by calendar month keeps each partition small,
 * makes retention a cheap DROP PARTITION, and preserves the original unique
 * identity (id) so Prisma reads/writes and upserts behave exactly as before.
 *
 * The helpers below are pure so they can be unit-tested for boundary values
 * (month edges, year rollover, invalid input) without a live database.
 */

/**
 * Compute the inclusive lower bound and exclusive upper bound of the monthly
 * partition that contains `date`. Boundaries are UTC so partitioning is stable
 * regardless of server timezone.
 *
 * @param {Date|string|number} date
 * @returns {{ name: string, start: Date, end: Date }}
 */
function getMonthlyPartitionBounds(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError('invalid date for partition bounds');
  }

  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const name = formatPartitionName(start);

  return { name, start, end };
}

/**
 * Format a partition name as `<prefix>_YYYY_MM` from the UTC month of `date`.
 *
 * @param {Date} date
 * @param {string} [prefix='activity_log']
 * @returns {string}
 */
function formatPartitionName(date, prefix = 'activity_log') {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}_${year}_${month}`;
}

/**
 * Build the SQL DDL that creates a monthly range partition for the given
 * month. The partition inherits the parent table's unique constraints (id),
 * so Prisma's `findUnique`/`upsert` on `id` continue to work unchanged.
 *
 * @param {Date|string|number} date
 * @param {Object} [options]
 * @param {string} [options.parent='activity_log']
 * @returns {string}
 */
function buildCreatePartitionSql(date, options = {}) {
  const parent = options.parent || 'activity_log';
  const { name, start, end } = getMonthlyPartitionBounds(date);
  const partitionName = formatPartitionName(start, parent);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  return (
    `CREATE TABLE IF NOT EXISTS ${partitionName} ` +
    `PARTITION OF ${parent} ` +
    `FOR VALUES FROM ('${startIso}') TO ('${endIso}');`
  );
}

/**
 * Build the SQL DDL that detaches and drops a monthly partition older than the
 * retention cutoff. Returns null when the partition is still within retention
 * so callers can skip it safely.
 *
 * @param {Date|string|number} date month to consider
 * @param {Object} [options]
 * @param {string} [options.parent='activity_log']
 * @param {Date|string|number} [options.cutoff] retention cutoff (exclusive)
 * @returns {string|null}
 */
function buildDropPartitionSql(date, options = {}) {
  const parent = options.parent || 'activity_log';
  const { start } = getMonthlyPartitionBounds(date);

  if (options.cutoff !== undefined && options.cutoff !== null) {
    const cutoff = options.cutoff instanceof Date ? options.cutoff : new Date(options.cutoff);
    if (Number.isNaN(cutoff.getTime())) {
      throw new RangeError('invalid retention cutoff');
    }
    // Only drop partitions whose entire range is older than the cutoff.
    if (start.getTime() >= cutoff.getTime()) {
      return null;
    }
  }

  const partitionName = formatPartitionName(start, parent);
  return `DROP TABLE IF EXISTS ${partitionName};`;
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
 * is always bounded so a single invocation 

/* … truncated 4474 chars — edit only what you need near the top … */
