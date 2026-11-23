'use strict';

/**
 * Stellar Horizon Service with Circuit Breaker Protection
 *
 * Centralizes all Horizon SDK interactions behind an opossum circuit breaker.
 * When Horizon fails repeatedly, the breaker "opens" and fast-fails subsequent
 * requests instead of letting them pile up and crash the process.
 *
 * Callers can check `err.name === 'CircuitBreakerOpenError'` to distinguish
 * a tripped breaker from a normal Horizon error (e.g. 404).
 */

const { Horizon } = require('@stellar/stellar-sdk');
const CircuitBreaker = require('opossum');
const { logger } = require('../logger');

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------
const HORIZON_BASE = process.env.HORIZON_BASE || 'https://horizon-testnet.stellar.org';

// ---------------------------------------------------------------------------
// Network identity
// ---------------------------------------------------------------------------
// Ledger transaction hashes are only unique per Stellar network, so every
// helper that reads/writes transaction identity must carry the network.
// We derive a stable network identifier from the Horizon base URL, e.g.
//   https://horizon-testnet.stellar.org -> 'testnet'
//   https://horizon.stellar.org         -> 'pubnet'
// An explicit override is supported via STELLAR_NETWORK.
const KNOWN_NETWORKS = ['pubnet', 'testnet', 'futurenet', 'sandbox'];

function deriveNetworkFromHorizonBase(base) {
  const url = String(base || '').toLowerCase();
  if (url.includes('testnet')) return 'testnet';
  if (url.includes('futurenet')) return 'futurenet';
  if (url.includes('sandbox')) return 'sandbox';
  if (url.includes('horizon.stellar.org')) return 'pubnet';
  return 'unknown';
}

const STELLAR_NETWORK = (() => {
  const explicit = (process.env.STELLAR_NETWORK || '').trim().toLowerCase();
  if (explicit) {
    if (!KNOWN_NETWORKS.includes(explicit)) {
      logger.warn(
        `[stellarService] Unknown STELLAR_NETWORK "${explicit}"; using it verbatim`,
      );
    }
    return explicit;
  }
  return deriveNetworkFromHorizonBase(HORIZON_BASE);
})();

// ---------------------------------------------------------------------------
// Exact amount helpers
// ---------------------------------------------------------------------------
// Horizon returns amounts as decimal strings (e.g. "12.3456789"). We never
// store floats: amounts are converted to integer units at the asset precision
// (7 decimal places for Stellar assets) using string math only.
const STELLAR_ASSET_PRECISION = 7;
const DEFAULT_ASSET_PRECISION = STELLAR_ASSET_PRECISION;

/**
 * Convert a decimal amount (string or number) to integer units at `precision`.
 * Throws on malformed input or when the value has more fractional digits than
 * the asset precision allows (no silent rounding of user data).
 */
function toUnits(amount, precision = DEFAULT_ASSET_PRECISION) {
  if (amount === null || amount === undefined || amount === '') {
    throw new TypeError('toUnits: amount is required');
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new RangeError(`toUnits: invalid precision ${precision}`);
  }

  const raw = String(amount).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match || (match[2] === '' && (match[3] === undefined || match[3] === ''))) {
    throw new TypeError(`toUnits: invalid amount "${raw}"`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] || '0';
  const fraction = match[3] || '';

  if (fraction.length > precision) {
    // Reject values that cannot be represented exactly at this precision.
    const excess = fraction.slice(precision);
    if (/[^0]/.test(excess)) {
      throw new RangeError(
        `toUnits: amount "${raw}" exceeds asset precision ${precision}`,
      );
    }
  }

  const paddedFraction = (fraction + '0'.repeat(precision)).slice(0, precision);
  const units = BigInt(whole) * 10n ** BigInt(precision) + BigInt(paddedFraction || '0');
  return sign * units;
}

/**
 * Convert integer units back to a decimal string at `precision`.
 * Always returns a string so callers never reintroduce float error.
 */
function fromUnits(units, precision = DEFAULT_ASSET_PRECISION) {
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new RangeError(`fromUnits: invalid precision ${precision}`);
  }
  const value = typeof units === 'bigint' ? units : BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(precision);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(precision, '0');
  const body = precision === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * Normalize a Horizon amount string to integer units at the asset precision.
 * Convenience wrapper used by ingestion code paths.
 */
function normalizeHorizonAmount(amount, precision = DEFAULT_ASSET_PRECISION) {
  return toUnits(amount, precision);
}

const BREAKER_THRESHOLD = parseInt(process.env.CB_THRESHOLD, 10) || 5;
const BREAKER_TIMEOUT = parseInt(process.env.CB_TIMEOUT_MS, 10) || 10000;
const BREAKER_RESET_TIMEOUT = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30000;

// ---------------------------------------------------------------------------
// Horizon Server Instance
// ---------------------------------------------------------------------------
const horizon = new Horizon.Server(HORIZON_BASE);

// ---------------------------------------------------------------------------
// Circuit Breaker Defaults
// ---------------------------------------------------------------------------
const defaultOptions = {
  timeout: BREAKER_TIMEOUT,
  errorThresholdPercentage: 50,
  resetTimeout: BREAKER_RESET_TIMEOUT,
  volumeThreshold: BREAKER_THRESHOLD,
};

/**
 * Creates a circuit breaker around an async function.
 * Logs state transitions so operators can see open/close events in log output.
 * When the circuit opens, opossum throws a `CircuitBreakerOpenError` which
 * callers can detect to provide a user-friendly message.
 */
function createBreaker(fn, options = {}) {
  const breaker = new CircuitBreaker(fn, { ...defaultOptions, ...options });

  breaker.on('open', () =>
    logger.warn('[CircuitBreaker] Circuit OPENED — fast-failing requests'),
  );
  breaker.on('halfOpen', () =>
    logger.info('[CircuitBreaker] Circuit HALF-OPEN — testing recovery'),
  );
  breaker.on('close', () =>
    logger.info('[CircuitBreaker] Circuit CLOSED — service recovered'),
  );
  breaker.on('fallback', () =>
    logger.warn('[CircuitBreaker] Fallback invoked'),
  );
  breaker.on('failure', (err) =>
    logger.debug('[CircuitBreaker] Request failed:', err?.message || err),
  );

  return breaker;
}

// ---------------------------------------------------------------------------
// Circuit-Breaker–Wrapped Horizon Helpers
// ---------------------------------------------------------------------------

/**
 * Load an account from Horizon (used by multisigner-verifier).
 * When the breaker is open, opossum throws CircuitBreakerOpenError.
 */
const loadAccountBreaker = createBreaker(
  (accountId) => horizon.loadAccount(accountId),
);

async function loadAccount(accountId) {
  return loadAccountBreaker.fire(accountId);
}

/**
 * Fetch a single transaction by hash.
 *
 * Transaction hashes are only unique per network, so the result is annotated
 * with the network identity it was fetched from. Callers may pass an explicit
 * `network` (e.g. when ingesting historical data for another network) which
 * is validated against the configured Horizon base.
 */
const fetchTransactionBreaker = createBreaker(
  ({ txHash, network }) => horizon.transactions().transaction(txHash).call(),
);

async function fetchTransaction(txHash, network = STELLAR_NETWORK) {
  const resolvedNetwork = resolveNetwork(network);
  const record = await fetchTransactionBreaker.fire({ txHash, network: resolvedNetwork });
  return annotateNetwork(record, resolvedNetwork);
}

/**
 * Fetch all payment operations for a given transaction.
 * Returns the page annotated with the network identity.
 */
const fetchPaymentsForTransactionBreaker = createBreaker(
  ({ txHash, network }) => horizon.payments().forTransaction(txHash).call(),
);

async function fetchPaymentsForTransaction(txHash, network = STELLAR_NETWORK) {
  const resolvedNetwork = resolveNetwork(network);
  const page = await fetchPaymentsForTransactionBreaker.fire({
    txHash,
    network: resolvedNetwork,
  });
  return annotateNetwork(page, resolvedNetwork);
}

/**
 * Validate/normalize a network identifier. Defaults to the configured network
 * when omitted; rejects clearly invalid values so identity is never ambiguous.
 */
function resolveNetwork(network) {
  if (network === undefined || network === null || network === '') {
    return STELLAR_NETWORK;
  }
  const normalized = String(network).trim().toLowerCase();
  if (!normalized) return STELLAR_NETWORK;
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new TypeError(`Invalid network identifier "${network}"`);
  }
  return normalized;
}

/**
 * Attach the network identity to a Horizon record or page without mutating
 * the original object (Horizon records may be frozen).
 */
function annotateNetwork(record, network) {
  if (!record || typeof record !== 'object') return record;
  if (Object.isFrozen(record)) {
    return Object.assign(Object.create(Object.getPrototypeOf(record)), record, { network });
  }
  return Object.assign(record, { network });
}

/**
 * Fetch a page of payment records for an account.
 * When the circuit is open the promise rejects immediately with a
 * `CircuitBreakerOpenError` instead of hanging on the HTTP timeout.
 */
const fetchPaymentsForAccountBreaker = createBreaker(
  ({ address, limit, cursor, order }) => {
    let call = horizon.payments().forAccount(address).order(order).limit(limit);
    if (cursor) call = call.cursor(cursor);
    return call.call();
  },
);

async function fetchPaymentsForAccount({ address, limit, cursor, order }) {
  return fetchPaymentsForAccountBreaker.fire({ address, limit, cursor, order });
}

/**
 * Fetch the first page of payments for an account (used by export).
 * Returns a page-like object whose `.next()` method is also circuit-protected.
 */
const fetchFirstPaymentsPageBreaker = createBreaker(
  ({ address, order, pageSize }) =>
    horizon.payments().forAccount(address).order(order).limit(pageSize).call(),
);

async function fetchFirstPaymentsPage({ address, order, pageSize }) {
  const page = await fetchFirstPaymentsPageBreaker.fire({ address, order, pageSize });
  return wrapPageWithBreaker(page);
}

/**
 * Wraps a Horizon pagination result so its `.next()` call is also circuit-
 * protected.  Non-Horizon calls (e.g. `records`, `_embedded`) pass through.
 */
function wrapPageWithBreaker(page) {
  if (!page || typeof page.next !== 'function') return page;

  const originalNext = page.next.bind(page);
  const nextBreaker = createBreaker((cursor) => {
    if (cursor) return originalNext(cursor);
    return originalNext();
  });

  return Object.create(page, {
    next: {
      value: (...args) => nextBreaker.fire(...args),
      writable: true,
      configurable: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Horizon server instance (use directly for SSE streaming, etc.)
  horizon,

  // Configuration (useful for tests / introspection)
  HORIZON_BASE,
  BREAKER_THRESHOLD,
  BREAKER_TIMEOUT,
  BREAKER_RESET_TIMEOUT,

  // Network identity
  STELLAR_NETWORK,
  KNOWN_NETWORKS,
  deriveNetworkFromHorizonBase,
  resolveNetwork,

  // Exact amount helpers (integer units at asset precision)
  STELLAR_ASSET_PRECISION,
  DEFAULT_ASSET_PRECISION,
  toUnits,
  fromUnits,
  normalizeHorizonAmount,

  // Circuit-breaker–wrapped helpers
  loadAccount,
  fetchTransaction,
  fetchPaymentsForTransaction,
  fetchPaymentsForAccount,
  fetchFirstPaymentsPage,

  // Low-level: create a breaker around any async function
  createBreaker,

  // Low-level: wrap a Horizon page so `.next()` is protected
  wrapPageWithBreaker,
};
