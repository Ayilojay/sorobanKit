const crypto = require('crypto');
const { Pool } = require('pg');
const { logger } = require('./logger');
const dotenv = require('dotenv');

dotenv.config();

// Pre-flight check: Prisma and pg both surface an opaque internal error when
// DATABASE_URL is absent. Catch this early and emit a clear, actionable
// message so a developer setting up the project for the first time knows
// exactly what to fix without digging into library internals.
if (!process.env.DATABASE_URL) {
  const message =
    'DATABASE_URL is not set — see README for database setup. ' +
    'Copy .env.example to .env and set DATABASE_URL to a valid PostgreSQL connection string.';
  logger.error(message);
  throw new Error(message);
}

// Initialization retry policy. Bounded and configurable so cold-start and
// outage tests can drive the retry loop quickly without waiting on the
// production defaults. DB_INIT_RETRIES is the number of *additional* attempts
// after the first failure; DB_INIT_RETRY_DELAY_MS is the backoff between them.
const DEFAULT_INIT_RETRIES = 5;
const DEFAULT_INIT_RETRY_DELAY_MS = 5000;

const parseNonNegativeInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const getInitRetries = () =>
  parseNonNegativeInt(process.env.DB_INIT_RETRIES, DEFAULT_INIT_RETRIES);

const getInitRetryDelayMs = () =>
  parseNonNegativeInt(process.env.DB_INIT_RETRY_DELAY_MS, DEFAULT_INIT_RETRY_DELAY_MS);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected error on idle PostgreSQL client');
});

const SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS username_registry (
      username TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ,
      failing_since TIMESTAMPTZ,
      UNIQUE(username, url),
      FOREIGN KEY (username) REFERENCES username_registry(username) ON DELETE CASCADE
    )
  `,
  `CREATE INDEX IF NOT EXISTS webhooks_username_idx ON webhooks(username)`,
  `CREATE INDEX IF NOT EXISTS webhooks_last_sent_at_idx ON webhooks(last_sent_at)`,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tracks the state of schema initialization so readiness probes and tests can
// observe cold-start progress without re-running migrations.
const initState = {
  status: 'pending',
  attempts: 0,
  lastError: null,
  ready: null,
};

const applySchema = async () => {
  for (const statement of SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
};

// Runs schema initialization with bounded retries. On final failure the pool is
// closed so no connections (or pending clients) are leaked, and the returned
// promise rejects with the last error. Callers may await this to model
// cold-start readiness; the module also kicks it off eagerly below.
const initializeDatabase = async () => {
  const maxRetries = getInitRetries();
  const retryDelayMs = getInitRetryDelayMs();
  let attempt = 0;

  initState.status = 'initializing';
  initState.lastError = null;

  while (attempt <= maxRetries) {
    attempt += 1;
    initState.attempts = attempt;
    try {
      await applySchema();
      initState.status = 'ready';
      initState.lastError = null;
      logger.info(`PostgreSQL pool initialised — max ${pool.options.max} connections`);
      return true;
    } catch (err) {
      initState.lastError = err;
      const retriesLeft = maxRetries - (attempt - 1);
      if (process.env.NODE_ENV === 'test') {
        logger.warn('PostgreSQL schema init skipped in test environment');
        initState.status = 'skipped';
        return false;
      }
      if (retriesLeft <= 0) {
        logger.error(err, 'Failed to initialise PostgreSQL schema. No retries left.');
        initState.status = 'failed';
        await closePool();
        throw err;
      }
      logger.error(err, `Failed to initialise PostgreSQL schema. Retries left: ${retriesLeft}`);
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }

  // Unreachable: the loop either returns or throws.
  initState.status = 'failed';
  await closePool();
  throw initState.lastError || new Error('PostgreSQL schema initialisation failed');
};

// Closes the pool and resolves once all clients are released. Safe to call
// multiple times; used by failed-init cleanup and by tests/shutdown hooks.
const closePool = async () => {
  try {
    await pool.end();
  } catch (err) {
    logger.warn(err, 'Error while closing PostgreSQL pool');
  }
};

// Exposed for fault-injection and cold-start tests: reset the observable state
// and re-run initialization against the current pool.
const resetInitState = () => {
  initState.status = 'pending';
  initState.attempts = 0;
  initState.lastError = null;
};

initState.ready = initializeDatabase().catch((err) => {
  // In production a failed cold start is fatal; tests observe the rejection via
  // initState.ready instead of terminating the process.
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
  throw err;
});
// Prevent an unhandled rejection warning when tests intentionally trigger a
// failed cold start and inspect initState.ready themselves.
initState.ready.catch(() => {});

const poolGet = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};

const poolRun = async (sql, params = []) => {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount };
};

const poolAll = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows;
};

const { USER_DATABASE, normalizeNameTag } = require('./utils');

const etagCache = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const bodyString = JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('hex');
    const etag = `"${hash}"`;

    res.set('ETag', etag);

    const clientEtag = req.get('If-None-Match');
    if (clientEtag && clientEtag === etag) {
      return res.status(304).end();
    }

    return originalJson(body);
  };

  next();
};

module.exports = {
  poolGet,
  poolRun,
  poolAll,
  pool,
  USER_DATABASE,
  normalizeNameTag,
  etagCache,
  // Fault-injection / cold-start hooks
  initializeDatabase,
  closePool,
  resetInitState,
  initState,
  getInitRetries,
  getInitRetryDelayMs,
};
