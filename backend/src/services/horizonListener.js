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

async function startHorizonListener(config) {
  const server = new Horizon.Server(config.horizonUrl);

  await verifyNetwork(server, config.horizonNetwork);

  logger.info(`Horizon listener connected to ${config.horizonUrl} (${config.horizonNetwork})`);

  const closeStream = server
    .payments()
    .cursor('now')
    .stream({
      onmessage: (payment) => {
        try {
          handlePayment(payment, config);
        } catch (err) {
          logger.error(`Error handling payment event: ${err.message}`);
        }
      },
      onerror: (err) => {
        logger.error(`Horizon stream error: ${err.message}`);
      },
    });

  return closeStream;
}

function handlePayment(payment, config) {
  logger.info(`Received payment event ${payment.id} of type ${payment.type}`);

  // Persistence boundary: stamp and validate schema metadata before handing
  // the event to downstream persistence.
  let event;
  try {
    event = validateEventPayload(payment);
  } catch (err) {
    logger.error(`Rejected payment event ${payment && payment.id}: ${err.message}`);
    return;
  }

  // Constrain the persisted lifecycle value to a canonical status. Unknown
  // statuses are rejected rather than written through.
  if (event.status !== undefined && event.status !== null) {
    try {
      event = { ...event, status: normalizePaymentStatus(event.status) };
    } catch (err) {
      logger.error(`Rejected payment event ${payment && payment.id}: ${err.message}`);
      return;
    }
  }

  if (typeof config.onPayment === 'function') {
    config.onPayment(event);
  }
  // Reporting is decoupled from the payment write path: the read model is
  // refreshed asynchronously and never blocks payment ingestion.
  if (typeof config.onReportingWatermark === 'function') {
    try {
      config.onReportingWatermark({
        source: 'horizon',
        cursor: payment.paging_token || payment.id,
        ledger: payment.ledger,
        observedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(`Error recording reporting watermark: ${err.message}`);
    }
  }
}

// Emit exactly one receipt for a successful routed payment and none on failure.
// Returns the receipt on success, or null when the payment did not succeed.
function emitReceipt(payment, config) {
  if (!payment || payment.successful === false) {
    return null;
  }
  const receipt = buildReceipt(payment);
  if (config && typeof config.onReceipt === 'function') {
    config.onReceipt(receipt);
  }
  return receipt;
}

module.exports = {
  startHorizonListener,
  verifyNetwork,
  getExpectedPassphrase,
  normalizeEventMetadata,
  validateEventPayload,
  adaptUnversionedEvent,
  normalizePaymentStatus,
  normalizeWebhookStatus,
  assertPaymentTransition,
  assertWebhookTransition,
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
};
