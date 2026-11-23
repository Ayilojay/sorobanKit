'use strict';

const { Horizon } = require('@stellar/stellar-sdk');
const logger = require('../utils/logger');

const NETWORK_PASSPHRASES = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

// Schema identifier stamped onto persisted event payloads at the persistence
// boundary. Bump EVENT_SCHEMA_VERSION when the persisted shape changes.
const EVENT_SCHEMA_ID = 'stellar.payment.event';
const EVENT_SCHEMA_VERSION = 1;
const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1];

// Canonical payment lifecycle statuses. These are the only values that may be
// persisted for a payment; legacy values are migrated via PAYMENT_STATUS_ALIASES.
const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  REVERSED: 'reversed',
});

const PAYMENT_STATUSES = Object.freeze(Object.values(PAYMENT_STATUS));

// Allowed payment lifecycle transitions. Terminal states have no outgoing edges.
const PAYMENT_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.PENDING]: [PAYMENT_STATUS.SUCCEEDED, PAYMENT_STATUS.FAILED],
  [PAYMENT_STATUS.SUCCEEDED]: [PAYMENT_STATUS.REVERSED],
  [PAYMENT_STATUS.FAILED]: [],
  [PAYMENT_STATUS.REVERSED]: [],
});

// Legacy persisted payment status values mapped to canonical values.
const PAYMENT_STATUS_ALIASES = Object.freeze({
  success: PAYMENT_STATUS.SUCCEEDED,
  succeeded: PAYMENT_STATUS.SUCCEEDED,
  complete: PAYMENT_STATUS.SUCCEEDED,
  completed: PAYMENT_STATUS.SUCCEEDED,
  confirmed: PAYMENT_STATUS.SUCCEEDED,
  error: PAYMENT_STATUS.FAILED,
  failed: PAYMENT_STATUS.FAILED,
  rejected: PAYMENT_STATUS.FAILED,
  refunded: PAYMENT_STATUS.REVERSED,
  reversed: PAYMENT_STATUS.REVERSED,
  pending: PAYMENT_STATUS.PENDING,
  processing: PAYMENT_STATUS.PENDING,
});

// Canonical webhook lifecycle statuses.
const WEBHOOK_STATUS = Object.freeze({
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  DEAD: 'dead',
});

const WEBHOOK_STATUSES = Object.freeze(Object.values(WEBHOOK_STATUS));

// Allowed webhook lifecycle transitions. Terminal states have no outgoing edges.
const WEBHOOK_TRANSITIONS = Object.freeze({
  [WEBHOOK_STATUS.PENDING]: [WEBHOOK_STATUS.DELIVERED, WEBHOOK_STATUS.FAILED],
  [WEBHOOK_STATUS.FAILED]: [WEBHOOK_STATUS.PENDING, WEBHOOK_STATUS.DEAD],
  [WEBHOOK_STATUS.DELIVERED]: [],
  [WEBHOOK_STATUS.DEAD]: [],
});

// Legacy persisted webhook status values mapped to canonical values.
const WEBHOOK_STATUS_ALIASES = Object.freeze({
  pending: WEBHOOK_STATUS.PENDING,
  queued: WEBHOOK_STATUS.PENDING,
  retrying: WEBHOOK_STATUS.PENDING,
  delivered: WEBHOOK_STATUS.DELIVERED,
  success: WEBHOOK_STATUS.DELIVERED,
  sent: WEBHOOK_STATUS.DELIVERED,
  failed: WEBHOOK_STATUS.FAILED,
  error: WEBHOOK_STATUS.FAILED,
  dead: WEBHOOK_STATUS.DEAD,
  exhausted: WEBHOOK_STATUS.DEAD,
});

// Time-based partitioning for high-volume history tables. Partitions are
// monthly, half-open ranges [start, end) on the event timestamp column. The
// partition key is derived from the same timestamp used by Prisma queries so
// existing read/write paths are unaffected; unique identities (id) remain
// globally unique across partitions.
const PARTITION_INTERVAL = 'month';
const PARTITIONED_TABLES = Object.freeze(['payment_history', 'webhook_history']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Compute the monthly partition boundary that contains the given timestamp.
// Returns { name, start, end } where start/end are ISO strings and the range
// is half-open [start, end). Throws on invalid input so callers fail loudly
// rather than writing to an unpartitioned fallback.
function getPartitionBoundary(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid partition timestamp: ${timestamp}`);
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const name = `${PARTITIONED_TABLES[0]}_${year}_${pad2(month + 1)}`;

  return {
    name,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

// Resolve the partition name for a given table and timestamp. Validates the
// table is a known partitioned history table.
function getPartitionName(table, timestamp) {
  if (!PARTITIONED_TABLES.includes(table)) {
    throw new Error(`Table is not time-partitioned: ${table}`);
  }
  const boundary = getPartitionBoundary(timestamp);
  const year = boundary.start.slice(0, 4);
  const month = boundary.start.slice(5, 7);
  return `${table}_${year}_${month}`;
}

// Determine whether a timestamp falls within a partition's half-open range.
// Used by boundary tests and retention maintenance.
function isWithinPartition(partition, timestamp) {
  if (!partition || !partition.start || !partition.end) {
    throw new Error('Partition boundary requires start and end');
  }
  const ts = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid partition timestamp: ${timestamp}`);
  }
  const start = new Date(partition.start).getTime();
  const end = new Date(partition.end).getTime();
  return ts >= start && ts < end;
}

// Retention maintenance: list partitions older than the retention cutoff so
// they can be detached/dropped without touching active partitions.
function getExpiredPartitions(partitions, retentionCutoff) {
  const cutoff = retentionCutoff instanceof Date ? retentionCutoff.getTime() : new Date(retentionCutoff).getTime();
  if (Number.isNaN(cutoff)) {
    throw new Error(`Invalid retention cutoff: ${retentionCutoff}`);
  }
  return (partitions || []).filter((partition) => {
    const end = new Date(partition.end).getTime();
    return !Number.isNaN(end) && end <= cutoff;
  });
}

function getExpectedPassphrase(network) {
  const key = String(network || '').toLowerCase();
  return NETWORK_PASSPHRASES[key] || null;
}

async function verifyNetwork(server, network) {
  const expected = getExpectedPassphrase(network);
  if (!expected) {
    logger.warn(`Unknown HORIZON_NETWORK "${network}"; skipping network verification`);
    return;
  }

  let root;
  try {
    root = await fetchRoot(server);
  } catch (err) {
    logger.error(`Failed to fetch Horizon root for network verification: ${err.message}`);
    throw err;
  }

  const actual = root && root.network_passphrase;
  if (actual !== expected) {
    logger.error(
      `Horizon network mismatch: expected "${expected}" for HORIZON_NETWORK=${network}, but Horizon reports "${actual}". Halting event processing.`
    );
    throw new Error('Horizon network passphrase mismatch');
  }
}

async function fetchRoot(server) {
  const response = await server.root();
  return response;
}

// Adapter for historical unversioned rows: treat them as schema v1.
function adaptUnversionedEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Cannot adapt non-object event payload');
  }
  return {
    ...payload,
    schemaId: EVENT_SCHEMA_ID,
    schemaVersion: 1,
  };
}

// Normalize any incoming event payload to a versioned envelope. Unversioned
// payloads are upgraded via the historical adapter; unknown future versions
// are rejected so they are not silently persisted with a wrong shape.
function normalizeEventMetadata(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Event payload must be an object');
  }

  const hasVersion = payload.schemaVersion !== undefined && payload.schemaVersion !== null;
  const versioned = hasVersion ? payload : adaptUnversionedEvent(payload);

  const version = Number(versioned.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid event schemaVersion: ${versioned.schemaVersion}`);
  }

  if (!SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(version)) {
    // Retention behavior: unknown future versions are retained (not dropped)
    // but flagged so downstream consumers can quarantine them.
    logger.warn(
      `Unknown future event schemaVersion ${version} for ${versioned.schemaId || EVENT_SCHEMA_ID}; retaining as unsupported`
    );
    return {
      ...versioned,
      schemaId: versioned.schemaId || EVENT_SCHEMA_ID,
      schemaVersion: version,
      schemaSupported: false,
    };
  }

  return {
    ...versioned,
    schemaId: versioned.schemaId || EVENT_SCHEMA_ID,
    schemaVersion: version,
    schemaSupported: true,
  };
}

// Validate a versioned event payload against its declared schema version.
function validateEventPayload(payload) {
  const normalized = normalizeEventMetadata(payload);

  if (!normalized.schemaSupported) {
    return normalized;
  }

  if (normalized.schemaId !== EVENT_SCHEMA_ID) {
    throw new Error(`Unexpected event schemaId: ${normalized.schemaId}`);
  }

  if (typeof normalized.id === 'undefined' || normalized.id === null) {
    throw new Error('Event payload missing required field: id');
  }

  if (typeof normalized.type !== 'string' || normalized.type.length === 0) {
    throw new Error('Event payload missing required field: type');
  }

  return normalized;
}

// Resolve a persisted payment status to its canonical value. Legacy aliases are
// migrated; unknown values are rejected so they are never written back.
function normalizePaymentStatus(value) {
  if (value === undefined || value === null) {
    throw new Error('Payment status is required');
  }
  const key = String(value).trim().toLowerCase();
  const canonical = PAYMENT_STATUS_ALIASES[key];
  if (!canonical) {
    throw new Error(`Unknown payment status: ${value}`);
  }
  return canonical;
}

// Resolve a persisted webhook status to its canonical value.
function normalizeWebhookStatus(value) {
  if (value === undefined || value === null) {
    throw new Error('Webhook status is required');
  }
  const key = String(value).trim().toLowerCase();
  const canonical = WEBHOOK_STATUS_ALIASES[key];
  if (!canonical) {
    throw new Error(`Unknown webhook status: ${value}`);
  }
  return canonical;
}

// Enforce an allowed payment lifecycle transition. Returns the canonical next
// status; throws on unknown or disallowed transitions.
function assertPaymentTransition(from, to) {
  const current = normalizePaymentStatus(from);
  const next = normalizePaymentStatus(to);
  const allowed = PAYMENT_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new Error(`Disallowed payment transition: ${current} -> ${next}`);
  }
  return next;
}

// Enforce an allowed webhook lifecycle transition.
function assertWebhookTransition(from, to) {
  const current = normalizeWebhookStatus(from);
  const next = normalizeWebhookStatus(to);
  const allowed = WEBHOOK_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new Error(`Disallowed webhook transition: ${current} -> ${next}`);
  }
  return next;
}

module.exports = {
  EVENT_SCHEMA_ID,
  EVENT_SCHEMA_VERSION,
  SUPPORTED_EVENT_SCHEMA_VERSIONS,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  PAYMENT_STATUS_ALIASES,
  WEBHOOK_STATUS,
  WEBHOOK_STATUSES,
  WEBHOOK_TRANSITIONS,
  WEBHOOK_STATUS_ALIASES,
  PARTITION_INTERVAL,
  PARTITIONED_TABLES,
  getPartitionBoundary,
  getPartitionName,
  isWithinPartition,
  getExpiredPartitions,
  getExpectedPassphrase,
  verifyNetwork,
  fetchRoot,
  adaptUnversionedEvent,
  normalizeEventMetadata,
  validateEventPayload,
  normalizePaymentStatus,
  normalizeWebhookStatus,
  assertPaymentTransition,
  assertWebhookTransition,
};
