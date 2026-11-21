'use strict';

const { Horizon } = require('@stellar/stellar-sdk');
const logger = require('../utils/logger');

const NETWORK_PASSPHRASES = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

// Versioned Soroban event schemas for payment, refund, and admin/governance actions.
// Symbols carry a version suffix (e.g. "payment:v1") so consumers can decode old
// versions while new versions are emitted. Bump EVENT_SCHEMA_VERSION when the
// payload shape changes and add a matching entry to EVENT_SCHEMAS.
const EVENT_SCHEMA_VERSION = 1;

const EVENT_SCHEMAS = {
  payment: {
    v1: {
      symbol: 'payment:v1',
      fields: ['id', 'from', 'to', 'amount', 'asset', 'memo'],
    },
  },
  refund: {
    v1: {
      symbol: 'refund:v1',
      fields: ['id', 'paymentId', 'to', 'amount', 'asset', 'reason'],
    },
  },
  admin: {
    v1: {
      symbol: 'admin:v1',
      fields: ['id', 'action', 'actor', 'target', 'metadata'],
    },
  },
};

function getEventSymbol(category, version = EVENT_SCHEMA_VERSION) {
  const schema = EVENT_SCHEMAS[category] && EVENT_SCHEMAS[category][`v${version}`];
  if (!schema) {
    throw new Error(`Unknown event schema ${category}:v${version}`);
  }
  return schema.symbol;
}

function getEventFields(category, version = EVENT_SCHEMA_VERSION) {
  const schema = EVENT_SCHEMAS[category] && EVENT_SCHEMAS[category][`v${version}`];
  if (!schema) {
    throw new Error(`Unknown event schema ${category}:v${version}`);
  }
  return schema.fields.slice();
}

function buildEventPayload(category, data, version = EVENT_SCHEMA_VERSION) {
  const fields = getEventFields(category, version);
  const payload = { version, symbol: getEventSymbol(category, version) };
  for (const field of fields) {
    payload[field] = data && data[field] !== undefined ? data[field] : null;
  }
  return payload;
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
  if (typeof config.onPayment === 'function') {
    config.onPayment(payment);
  }
}

module.exports = {
  startHorizonListener,
  verifyNetwork,
  getExpectedPassphrase,
  NETWORK_PASSPHRASES,
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMAS,
  getEventSymbol,
  getEventFields,
  buildEventPayload,
};
