'use strict';

const logger = require('./logger');

const DB_POOL_WAIT_ALERT = parseInt(process.env.DB_POOL_WAIT_ALERT, 10) || 10;
const CHECK_INTERVAL_MS = parseInt(process.env.DB_POOL_CHECK_INTERVAL_MS, 10) || 5000;

// Interactive request statement budget (ms). Distinct from maintenance budgets.
const DB_INTERACTIVE_STATEMENT_TIMEOUT_MS =
  parseInt(process.env.DB_INTERACTIVE_STATEMENT_TIMEOUT_MS, 10) || 5000;
// Maintenance task statement budget (ms) — intentionally more generous.
const DB_MAINTENANCE_STATEMENT_TIMEOUT_MS =
  parseInt(process.env.DB_MAINTENANCE_STATEMENT_TIMEOUT_MS, 10) || 60000;

// Postgres SQLSTATE for query_canceled (statement_timeout / cancel).
const STATEMENT_TIMEOUT_SQLSTATE = '57014';

let monitorTimer = null;
let pool = null;

function collectPoolMetrics() {
  if (!pool) {
    return { total: 0, idle: 0, waiting: 0 };
  }

  return {
    total: typeof pool.totalCount === 'number' ? pool.totalCount : 0,
    idle: typeof pool.idleCount === 'number' ? pool.idleCount : 0,
    waiting: typeof pool.waitingCount === 'number' ? pool.waitingCount : 0,
  };
}

function checkWaitQueue() {
  const metrics = collectPoolMetrics();
  const waiting = metrics.waiting;

  if (waiting > 2 * DB_POOL_WAIT_ALERT) {
    logger.error('DB pool wait queue critically high', {
      waiting,
      threshold: DB_POOL_WAIT_ALERT,
    });
  } else if (waiting > DB_POOL_WAIT_ALERT) {
    logger.warn('DB pool wait queue high', { waiting });
  }

  return metrics;
}

function isStatementTimeout(err) {
  if (!err) {
    return false;
  }
  return err.code === STATEMENT_TIMEOUT_SQLSTATE || /statement timeout/i.test(err.message || '');
}

// Map a statement timeout to a safe API error (no internal details leaked).
function toSafeTimeoutError(err) {
  const safe = new Error('Database request timed out');
  safe.status = 503;
  safe.code = 'DB_STATEMENT_TIMEOUT';
  safe.expose = true;
  if (err && err.stack) {
    safe.cause = err;
  }
  return safe;
}

// Run an interactive query with a bounded statement timeout, cancelling
// over-budget statements and releasing the pooled connection afterwards.
async function runInteractiveQuery(dbPool, text, params, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DB_INTERACTIVE_STATEMENT_TIMEOUT_MS;
  const targetPool = dbPool || pool;

  if (!targetPool) {
    throw new Error('Database pool not initialized');
  }

  const client = await targetPool.connect();
  let timer = null;
  let timedOut = false;

  try {
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);

    timer = setTimeout(() => {
      timedOut = true;
      // Cancel the in-flight statement so the backend stops work promptly.
      if (typeof client.cancel === 'function') {
        Promise.resolve(client.cancel()).catch((cancelErr) => {
          logger.warn('Failed to cancel over-budget statement', {
            error: cancelErr && cancelErr.message,
          });
        });
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    return await client.query(text, params);
  } catch (err) {
    if (timedOut || isStatementTimeout(err)) {
      logger.warn('Interactive statement exceeded budget', {
        timeoutMs,
        error: err && err.message,
      });
      throw toSafeTimeoutError(err);
    }
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // Always release the client so the pool recovers after cancellation.
    client.release(timedOut ? true : undefined);
  }
}

function startMonitor(dbPool) {
  pool = dbPool;

  if (monitorTimer) {
    return;
  }

  monitorTimer = setInterval(() => {
    try {
      checkWaitQueue();
    } catch (err) {
      logger.error('DB pool monitor check failed', { error: err.message });
    }
  }, CHECK_INTERVAL_MS);

  if (typeof monitorTimer.unref === 'function') {
    monitorTimer.unref();
  }
}

function stopMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  pool = null;
}

module.exports = {
  DB_POOL_WAIT_ALERT,
  CHECK_INTERVAL_MS,
  DB_INTERACTIVE_STATEMENT_TIMEOUT_MS,
  DB_MAINTENANCE_STATEMENT_TIMEOUT_MS,
  STATEMENT_TIMEOUT_SQLSTATE,
  collectPoolMetrics,
  checkWaitQueue,
  isStatementTimeout,
  toSafeTimeoutError,
  runInteractiveQuery,
  startMonitor,
  stopMonitor,
};
