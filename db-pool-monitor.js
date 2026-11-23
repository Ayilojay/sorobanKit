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

// Default per-replica pool sizes and replica counts used for capacity budgeting.
const DEFAULT_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE, 10) || 10;
const DEFAULT_REPLICAS = {
  api: parseInt(process.env.API_REPLICAS, 10) || 1,
  worker: parseInt(process.env.WORKER_REPLICAS, 10) || 1,
  migration: parseInt(process.env.MIGRATION_REPLICAS, 10) || 1,
  monitoring: parseInt(process.env.MONITORING_REPLICAS, 10) || 1,
};
// Connections reserved for administration (superuser / ops) so they stay available.
const DB_ADMIN_RESERVED_CONNECTIONS =
  parseInt(process.env.DB_ADMIN_RESERVED_CONNECTIONS, 10) || 5;
// Database connection limit (max_connections). 0/undefined disables validation.
const DB_MAX_CONNECTIONS = parseInt(process.env.DB_MAX_CONNECTIONS, 10) || 0;

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

// Aggregate the total possible connections across all replica groups.
// Each group contributes replicas * perReplicaPoolSize.
function aggregateConnectionCapacity(config) {
  const cfg = config || {};
  const replicas = Object.assign({}, DEFAULT_REPLICAS, cfg.replicas || {});
  const poolSize = typeof cfg.poolSize === 'number' ? cfg.poolSize : DEFAULT_POOL_SIZE;

  const groups = {};
  let total = 0;
  Object.keys(replicas).forEach((name) => {
    const count = Number(replicas[name]) || 0;
    const groupTotal = count * poolSize;
    groups[name] = { replicas: count, poolSize, total: groupTotal };
    total += groupTotal;
  });

  return { groups, poolSize, total };
}

// Validate aggregated configured capacity against the database limit, reserving
// headroom for administration. Returns a structured result; throws on overflow.
function validateConnectionCapacity(config) {
  const cfg = config || {};
  const capacity = aggregateConnectionCapacity(cfg);
  const maxConnections =
    typeof cfg.maxConnections === 'number' ? cfg.maxConnections : DB_MAX_CONNECTIONS;
  const reserved =
    typeof cfg.reserved === 'number' ? cfg.reserved : DB_ADMIN_RESERVED_CONNECTIONS;

  const result = {
    total: capacity.total,
    groups: capacity.groups,
    poolSize: capacity.poolSize,
    maxConnections,
    reserved,
    available: maxConnections > 0 ? maxConnections - reserved : null,
    ok: true,
  };

  // Validation is disabled when no database limit is configured.
  if (!maxConnections || maxConnections <= 0) {
    return result;
  }

  if (capacity.total > result.available) {
    result.ok = false;
    const err = new Error(
      `Configured connection capacity (${capacity.total}) exceeds database limit ` +
        `(${maxConnections}) minus reserved admin headroom (${reserved}) = ${result.available}`
    );
    err.code = 'DB_CAPACITY_EXCEEDED';
    err.capacity = result;
    throw err;
  }

  return result;
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
  DEFAULT_POOL_SIZE,
  DEFAULT_REPLICAS,
  DB_ADMIN_RESERVED_CONNECTIONS,
  DB_MAX_CONNECTIONS,
  collectPoolMetrics,
  aggregateConnectionCapacity,
  validateConnectionCapacity,
  checkWaitQueue,
  isStatementTimeout,
  toSafeTimeoutError,
  runInteractiveQuery,
  startMonitor,
  stopMonitor,
};
