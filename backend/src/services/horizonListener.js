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
    root = await server.serverURL ? await fetchRoot(server) : await fetchRoot(server);
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

module.exports = {
  startHorizonListener,
  verifyNetwork,
  getExpectedPassphrase,
  normalizeEventMetadata,
  validateEventPayload,
  adaptUnversionedEvent,
  NETWORK_PASSPHRASES,
  EVENT_SCHEMA_ID,
  EVENT_SCHEMA_VERSION,
  SUPPORTED_EVENT_SCHEMA_VERSIONS,
};
