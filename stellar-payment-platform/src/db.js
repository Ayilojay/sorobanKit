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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected error on idle PostgreSQL client');
});

// Readiness-aware connection state. The shutdown coordinator flips this to
// 'draining' once HTTP and background work have stopped accepting new work so
// health checks can report the process as not-ready while in-flight operations
// finish, then to 'closed' once the pool and Prisma client are released.
const connectionState = {
  status: 'ready',
  prismaClosed: false,
  poolClosed: false,
};

const getConnectionState = () => ({ ...connectionState });

const isReady = () => connectionState.status === 'ready';

const setConnectionState = (status) => {
  if (status !== 'ready' && status !== 'draining' && status !== 'closed') {
    throw new Error(`Invalid connection state: ${status}`);
  }
  connectionState.status = status;
  return getConnectionState();
};

// Lazily resolve the Prisma client so this module stays usable in contexts
// (tests, scripts) that never touch Prisma. Returns null when unavailable.
const resolvePrismaClient = () => {
  try {
    // eslint-disable-next-line global-require
    const prismaModule = require('./prisma');
    return prismaModule && (prismaModule.prisma || prismaModule.default) ? (prismaModule.prisma || prismaModule.default) : null;
  } catch (err) {
    return null;
  }
};

let prismaClosePromise = null;

// Close the Prisma client exactly once. Idempotent: repeated calls return the
// same promise so the shutdown coordinator can await it safely.
const closePrisma = () => {
  if (prismaClosePromise) return prismaClosePromise;
  prismaClosePromise = (async () => {
    const client = resolvePrismaClient();
    if (client && typeof client.$disconnect === 'function') {
      await client.$disconnect();
    }
    connectionState.prismaClosed = true;
    return true;
  })().catch((err) => {
    // Allow a retry on failure rather than caching a rejected promise.
    prismaClosePromise = null;
    throw err;
  });
  return prismaClosePromise;
};

let poolClosePromise = null;

// Close the pg Pool exactly once. Idempotent for the same reason as above.
const closePool = () => {
  if (poolClosePromise) return poolClosePromise;
  poolClosePromise = (async () => {
    await pool.end();
    connectionState.poolClosed = true;
    return true;
  })().catch((err) => {
    poolClosePromise = null;
    throw err;
  });
  return poolClosePromise;
};

// Close database resources in a defined order: Prisma first (it may hold
// connections through the pool), then the pg Pool itself.
const closeDatabase = async () => {
  await closePrisma();
  await closePool();
  connectionState.status = 'closed';
  return getConnectionState();
};

(async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS username_registry (
          username TEXT PRIMARY KEY,
          address TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
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
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS webhooks_username_idx ON webhooks(username)`).catch(() => {});
      await pool.query(`CREATE INDEX IF NOT EXISTS webhooks_last_sent_at_idx ON webhooks(last_sent_at)`).catch(() => {});
      logger.info(`PostgreSQL pool initialised — max ${pool.options.max} connections`);
      return;
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        logger.warn('PostgreSQL schema init skipped in test environment');
        return;
      }
      retries -= 1;
      logger.error(err, `Failed to initialise PostgreSQL schema. Retries left: ${retries}`);
      if (retries === 0) {
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
})();

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
  closePrisma,
  closePool,
  closeDatabase,
  getConnectionState,
  setConnectionState,
  isReady,
};
