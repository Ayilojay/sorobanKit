'use strict';

const crypto = require('crypto');
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

// ---------------------------------------------------------------------------
// Archival of completed payment records (issue #394).
//
// Archival eligibility is restricted to terminal payment statuses that are old
// enough to be safely off the hot path. Active reconciliation and payment
// queries continue to read from the live tables; only records that have been
// terminal for at least ARCHIVE_MIN_AGE_MS are eligible. Archived records are
// serialized into an encrypted, integrity-checked envelope and can be restored
// through an authorized, bounded-latency API.
// ---------------------------------------------------------------------------

// Terminal statuses eligible for archival. PENDING is never eligible because
// it may still transition and is required by active reconciliation.
const ARCHIVABLE_PAYMENT_STATUSES = Object.freeze([
  PAYMENT_STATUS.SUCCEEDED,
  PAYMENT_STATUS.FAILED,
  PAYMENT_STATUS.REVERSED,
]);

// Minimum age (since the record reached a terminal state) before it may be
// archived. Defaults to 90 days; overridable via ARCHIVE_MIN_AGE_MS.
const DEFAULT_ARCHIVE_MIN_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Retention window for archived records. Archives older than this are eligible
// for purge. Defaults to 7 years; overridable via ARCHIVE_RETENTION_MS.
const DEFAULT_ARCHIVE_RETENTION_MS = 7 * 365 * 24 * 60 * 60 * 1000;

// Bounded restore latency: the maximum number of records a single restore call
// may return, and the maximum wall-clock budget for a restore operation.
const ARCHIVE_RESTORE_MAX_RECORDS = 1000;
const ARCHIVE_RESTORE_MAX_LATENCY_MS = 5000;

// Archive envelope format identifier and version.
const ARCHIVE_FORMAT_ID = 'stellar.payment.archive';
const ARCHIVE_FORMAT_VERSION = 1;
const SUPPORTED_ARCHIVE_FORMAT_VERSIONS = [1];

// Encryption parameters for the archive envelope. AES-256-GCM provides both
// confidentiality and an authenticated integrity tag over the ciphertext.
const ARCHIVE_CIPHER = 'aes-256-gcm';
const ARCHIVE_IV_BYTES = 12;
const ARCHIVE_AUTH_TAG_BYTES = 16;

function resolveArchiveMinAgeMs(env = process.env) {
  const raw = env && env.ARCHIVE_MIN_AGE_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_ARCHIVE_MIN_AGE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ARCHIVE_MIN_AGE_MS: ${raw}`);
  }
  return parsed;
}

function resolveArchiveRetentionMs(env = process.env) {
  const raw = env && env.ARCHIVE_RETENTION_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_ARCHIVE_RETENTION_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ARCHIVE_RETENTION_MS: ${raw}`);
  }
  return parsed;
}

// Determine whether a payment record is eligible for archival. A record is
// eligible only when its status is terminal, it has a valid terminal timestamp,
// and it has been terminal for at least minAgeMs. PENDING records and records
// with unknown statuses are never eligible, keeping active reconciliation and
// hot-path payment queries unaffected.
function isArchivablePayment(record, options = {}) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  const status = PAYMENT_STATUS_ALIASES[String(record.status || '').toLowerCase()];
  if (!ARCHIVABLE_PAYMENT_STATUSES.includes(status)) {
    return false;
  }

  const minAgeMs = options.minAgeMs !== undefined
    ? options.minAgeMs
    : resolveArchiveMinAgeMs(options.env);
  const now = options.now instanceof Date ? options.now.getTime() : (options.now !== undefined ? new Date(options.now).getTime() : Date.now());
  if (Number.isNaN(now)) {
    throw new Error(`Invalid archival reference time: ${options.now}`);
  }

  const terminalAtRaw = record.terminalAt || record.updatedAt || record.createdAt;
  if (!terminalAtRaw) {
    return false;
  }
  const terminalAt = terminalAtRaw instanceof Date ? terminalAtRaw.getTime() : new Date(terminalAtRaw).getTime();
  if (Number.isNaN(terminalAt)) {
    return false;
  }

  return now - terminalAt >= minAgeMs;
}

// Filter a batch of payment records down to those eligible for archival.
function selectArchivablePayments(records, options = {}) {
  return (records || []).filter((record) => isArchivablePayment(record, options));
}

function resolveArchiveKey(key) {
  const material = key || (process.env && process.env.ARCHIVE_ENCRYPTION_KEY);
  if (!material) {
    throw new Error('Archive encryption key is required');
  }
  if (Buffer.isBuffer(material)) {
    if (material.length !== 32) {
      throw new Error('Archive encryption key must be 32 bytes');
    }
    return material;
  }
  const buf = Buffer.from(String(material), 'utf8');
  if (buf.length === 32) {
    return buf;
  }
  // Derive a stable 32-byte key from arbitrary-length secret material.
  return crypto.createHash('sha256').update(buf).digest();
}

function computeArchiveChecksum(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

// Serialize and encrypt a batch of payment records into an archive envelope.
// The envelope carries a plaintext checksum of the payload for integrity
// verification independent of the cipher's authentication tag, plus the GCM
// auth tag which authenticates the ciphertext.
function createArchiveEnvelope(records, options = {}) {
  const key = resolveArchiveKey(options.key);
  const payload = {
    formatId: ARCHIVE_FORMAT_ID,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt: (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).toISOString(),
    records: Array.isArray(records) ? records : [],
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const checksum = computeArchiveChecksum(plaintext);
  const iv = crypto.randomBytes(ARCHIVE_IV_BYTES);
  const cipher = crypto.createCipheriv(ARCHIVE_CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    formatId: ARCHIVE_FORMAT_ID,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    cipher: ARCHIVE_CIPHER,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    checksum,
    recordCount: payload.records.length,
    createdAt: payload.createdAt,
    ciphertext: ciphertext.toString('base64'),
  };
}

// Decrypt and verify an archive envelope. Throws on unknown format versions,
// tampered ciphertext (GCM auth failure), or checksum mismatch.
function openArchiveEnvelope(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Archive envelope must be an object');
  }
  if (envelope.formatId !== ARCHIVE_FORMAT_ID) {
    throw new Error(`Unknown archive format: ${envelope.formatId}`);
  }
  const version = Number(envelope.formatVersion);
  if (!SUPPORTED_ARCHIVE_FORMAT_VERSIONS.includes(version)) {
    throw new Error(`Unsupported archive format version: ${envelope.formatVersion}`);
  }
  if (envelope.cipher !== ARCHIVE_CIPHER) {
    throw new Error(`Unsupported archive cipher: ${envelope.cipher}`);
  }

  const key = resolveArchiveKey(options.key);
  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  if (iv.length !== ARCHIVE_IV_BYTES || authTag.length !== ARCHIVE_AUTH_TAG_BYTES) {
    throw new Error('Archive envelope has invalid IV or auth tag');
  }

  const decipher = crypto.createDecipheriv(ARCHIVE_CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch (err) {
    throw new Error(`Archive integrity check failed: ${err.message}`);
  }

  const checksum = computeArchiveChecksum(plaintext);
  if (checksum !== envelope.checksum) {
    throw new Error('Archive checksum mismatch');
  }

  const payload = JSON.parse(plaintext.toString('utf8'));
  if (payload.formatId !== ARCHIVE_FORMAT_ID || Number(payload.formatVersion) !== version) {
    throw new Error('Archive payload format mismatch');
  }
  return payload;
}

// Determine whether an archive has exceeded its retention window and is
// eligible for purge.
function isArchiveExpired(envelope, options = {}) {
  if (!envelope || !envelope.createdAt) {
    throw new Error('Archive envelope requires createdAt');
  }
  const retentionMs = options.retentionMs !== undefined
    ? options.retentionMs
    : resolveArchiveRetentionMs(options.env);
  const now = options.now instanceof Date ? options.now.getTime() : (options.now !== undefined ? new Date(options.now).getTime() : Date.now());
  if (Number.isNaN(now)) {
    throw new Error(`Invalid retention reference time: ${options.now}`);
  }
  const createdAt = new Date(envelope.createdAt).getTime();
  if (Number.isNaN(createdAt)) {
    throw new Error(`Invalid archive createdAt: ${envelope.createdAt}`);
  }
  return now - createdAt >= retentionMs;
}

// Authorized restore API. Restores records from an archive envelope with a
// bounded number of records and a bounded wall-clock latency budget. Callers
// must supply an authorization check; unauthorized callers are rejected before
// any decryption work is performed.
function restoreArchivedPayments(envelope, options = {}) {
  const authorize = options.authorize;
  if (typeof authorize !== 'function' || authorize(options.context) !== true) {
    throw new Error('Unauthorized archive restore');
  }

  const maxRecords = options.maxRecords !== undefined
    ? options.maxRecords
    : ARCHIVE_RESTORE_MAX_RECORDS;
  const maxLatencyMs = options.maxLatencyMs !== undefined
    ? options.maxLatencyMs
    : ARCHIVE_RESTORE_MAX_LATENCY_MS;
  const startedAt = Date.now();

  const payload = openArchiveEnvelope(envelope, { key: options.key });
  const records = payload.records || [];
  if (records.length > maxRecords) {
    throw new Error(`Restore exceeds max records (${maxRecords})`);
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed > maxLatencyMs) {
    throw new Error(`Restore exceeded latency budget (${maxLatencyMs}ms)`);
  }

  return { records, elapsedMs: elapsed };
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
    throw new Error(`Unsupported event schemaVersion: ${versioned.schemaVersion}`);
  }

  return {
    ...versioned,
    schemaId: EVENT_SCHEMA_ID,
    schemaVersion: version,
  };
}

module.exports = {
  NETWORK_PASSPHRASES,
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
  ARCHIVABLE_PAYMENT_STATUSES,
  DEFAULT_ARCHIVE_MIN_AGE_MS,
  DEFAULT_ARCHIVE_RETENTION_MS,
  ARCHIVE_RESTORE_MAX_RECORDS,
  ARCHIVE_RESTORE_MAX_LATENCY_MS,
  ARCHIVE_FORMAT_ID,
  ARCHIVE_FORMAT_VERSION,
  SUPPORTED_ARCHIVE_FORMAT_VERSIONS,
  ARCHIVE_CIPHER,
  resolveArchiveMinAgeMs,
  resolveArchiveRetentionMs,
  isArchivablePayment,
  selectArchivablePayments,
  computeArchiveChecksum,
  createArchiveEnvelope,
  openArchiveEnvelope,
  isArchiveExpired,
  restoreArchivedPayments,
};
