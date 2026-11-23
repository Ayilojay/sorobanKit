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
const { getPool } = require('../db');

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------
const HORIZON_BASE = process.env.HORIZON_BASE || 'https://horizon-testnet.stellar.org';

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
 */
const fetchTransactionBreaker = createBreaker(
  (txHash) => horizon.transactions().transaction(txHash).call(),
);

async function fetchTransaction(txHash) {
  return fetchTransactionBreaker.fire(txHash);
}

/**
 * Fetch all payment operations for a given transaction.
 */
const fetchPaymentsForTransactionBreaker = createBreaker(
  (txHash) => horizon.payments().forTransaction(txHash).call(),
);

async function fetchPaymentsForTransaction(txHash) {
  return fetchPaymentsForTransactionBreaker.fire(txHash);
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

// ---------------------------------------------------------------------------
// Durable Stream Cursors
// ---------------------------------------------------------------------------
// Per-network stream cursors are persisted so a scan can resume from the last
// committed paging token instead of replaying the whole account history. The
// cursor is only advanced *after* a page has been fully processed, and the
// upsert is atomic (single statement) so concurrent workers cannot regress it.

const DEFAULT_CURSOR_TABLE = 'stellar_stream_cursors';

function cursorTableName() {
  // Table name is not user input, but keep it overridable for tests.
  return process.env.STELLAR_CURSOR_TABLE || DEFAULT_CURSOR_TABLE;
}

function networkOf(network) {
  return network || process.env.STELLAR_NETWORK || 'testnet';
}

/**
 * Read the committed cursor for a (network, stream) pair.
 * Returns `null` when no cursor has been committed yet.
 */
async function getCommittedCursor({ network, stream, db } = {}) {
  const client = db || getPool();
  const table = cursorTableName();
  const { rows } = await client.query(
    `SELECT cursor FROM ${table} WHERE network = $1 AND stream = $2`,
    [networkOf(network), stream],
  );
  return rows.length ? rows[0].cursor : null;
}

/**
 * Atomically advance the committed cursor for a (network, stream) pair.
 *
 * The upsert only moves the cursor forward: if a concurrent worker already
 * committed a later token, the older token is ignored. This keeps the cursor
 * monotonic even when pages are processed out of order or retried.
 */
async function commitCursor({ network, stream, cursor, db } = {}) {
  if (!cursor) return null;
  const client = db || getPool();
  const table = cursorTableName();
  const { rows } = await client.query(
    `INSERT INTO ${table} (network, stream, cursor, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (network, stream) DO UPDATE
       SET cursor = EXCLUDED.cursor, updated_at = NOW()
       WHERE ${table}.cursor IS NULL OR ${table}.cursor < EXCLUDED.cursor
     RETURNING cursor`,
    [networkOf(network), stream, cursor],
  );
  return rows.length ? rows[0].cursor : null;
}

/**
 * Deduplicate a page of records by their stable identity.
 *
 * Horizon payment records expose `paging_token` (and `id` for some record
 * types). We key on whichever is present so replaying a page — e.g. after a
 * crash between processing and cursor commit — is idempotent.
 */
function dedupeRecords(records, seen) {
  const out = [];
  for (const record of records || []) {
    const key = record && (record.paging_token || record.id);
    if (!key) {
      out.push(record);
      continue;
    }
    if (seen && seen.has(key)) continue;
    if (seen) seen.add(key);
    out.push(record);
  }
  return out;
}

/**
 * Process a single page: dedupe, hand records to the caller, then commit the
 * cursor. The cursor is committed only after `onPage` resolves successfully,
 * so a failure mid-page leaves the cursor at the last fully processed point.
 */
async function processPage({
  network,
  stream,
  page,
  onPage,
  seen,
  db,
} = {}) {
  const records = dedupeRecords(page && page.records, seen);
  if (onPage) await onPage(records, page);
  const last = records.length
    ? records[records.length - 1].paging_token || records[records.length - 1].id
    : null;
  if (last) await commitCursor({ network, stream, cursor: last, db });
  return records;
}

/**
 * Bounded backfill: walk pages forward from the committed cursor until the
 * page is exhausted or `maxPages` is reached. Returns the number of pages
 * processed so the caller can decide whether to continue backfilling or
 * switch to live-tail streaming.
 */
async function backfill({
  address,
  network,
  stream,
  order = 'asc',
  pageSize = 200,
  maxPages = 50,
  onPage,
  db,
} = {}) {
  const seen = new Set();
  let cursor = await getCommittedCursor({ network, stream, db });
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchPaymentsForAccount({
      address,
      limit: pageSize,
      cursor,
      order,
    });
    const records = await processPage({ network, stream, page, onPage, seen, db });
    pages += 1;
    if (!records.length || !page || typeof page.next !== 'function') break;
    const last = records[records.length - 1];
    cursor = last.paging_token || last.id || cursor;
    if (!page.records || page.records.length < pageSize) break;
  }

  return { pages, cursor };
}

/**
 * Live-tail streaming: follow new pages from the committed cursor. Each page
 * is processed and committed exactly like backfill, but the loop is driven by
 * the caller (e.g. a poll interval) rather than a bounded page budget.
 */
async function liveTail({
  address,
  network,
  stream,
  order = 'asc',
  pageSize = 200,
  onPage,
  db,
  shouldStop,
} = {}) {
  const seen = new Set();
  let cursor = await getCommittedCursor({ network, stream, db });

  while (!(shouldStop && shouldStop())) {
    const page = await fetchPaymentsForAccount({
      address,
      limit: pageSize,
      cursor,
      order,
    });
    const records = await processPage({ network, stream, page, onPage, seen, db });
    if (records.length) {
      const last = records[records.length - 1];
      cursor = last.paging_token || last.id || cursor;
    }
    if (!page || !page.records || page.records.length < pageSize) break;
  }

  return { cursor };
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

  // Durable stream cursors
  getCommittedCursor,
  commitCursor,
  dedupeRecords,
  processPage,
  backfill,
  liveTail,
};
