const IORedis = require('ioredis');

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

// Bounded retry/backoff defaults. These keep reconnection attempts predictable
// during fault-injection tests (disconnect, slow response, reconnection) while
// still allowing BullMQ workers to block on commands.
const DEFAULT_RETRY_STRATEGY = (times) => Math.min(times * 100, 2000);
const DEFAULT_MAX_RETRIES_PER_REQUEST = null;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_ENABLE_OFFLINE_QUEUE = true;

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === 'true';
};

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const buildRedisOptions = (overrides = {}) => {
  return {
    // BullMQ workers require blocking Redis commands to wait indefinitely.
    maxRetriesPerRequest: parseInteger(
      process.env.REDIS_MAX_RETRIES_PER_REQUEST,
      DEFAULT_MAX_RETRIES_PER_REQUEST
    ),
    retryStrategy: DEFAULT_RETRY_STRATEGY,
    connectTimeout: parseInteger(
      process.env.REDIS_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS
    ),
    commandTimeout: parseInteger(
      process.env.REDIS_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS
    ),
    enableOfflineQueue: parseBoolean(
      process.env.REDIS_ENABLE_OFFLINE_QUEUE,
      DEFAULT_ENABLE_OFFLINE_QUEUE
    ),
    // Do not let a single connection attempt hang forever in tests.
    enableReadyCheck: true,
    lazyConnect: false,
    ...overrides,
  };
};

const attachConnectionHandlers = (client, { logger = console } = {}) => {
  if (!client || typeof client.on !== 'function') return client;

  client.on('error', (err) => {
    // Swallow connection errors so an outage does not crash the process; the
    // retry strategy handles reconnection. Tests can assert on this behavior.
    if (logger && typeof logger.warn === 'function') {
      logger.warn('[redis] connection error', err && err.message);
    }
  });

  client.on('reconnecting', (delay) => {
    if (logger && typeof logger.info === 'function') {
      logger.info(`[redis] reconnecting in ${delay}ms`);
    }
  });

  client.on('ready', () => {
    if (logger && typeof logger.info === 'function') {
      logger.info('[redis] connection ready');
    }
  });

  return client;
};

const createRedisConnection = (overrides = {}) => {
  const url = overrides.url || process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const { url: _ignoredUrl, logger, ...rest } = overrides;
  const client = new IORedis(url, buildRedisOptions(rest));
  return attachConnectionHandlers(client, { logger });
};

const closeRedisConnection = async (client) => {
  if (!client) return;
  try {
    if (typeof client.quit === 'function' && client.status === 'ready') {
      await client.quit();
      return;
    }
  } catch (err) {
    // Fall through to disconnect on quit failure.
  }
  try {
    if (typeof client.disconnect === 'function') {
      client.disconnect();
    }
  } catch (err) {
    // Ignore disconnect errors during cleanup.
  }
};

/**
 * Gracefully close an ioredis client.
 *
 * Uses QUIT so pending commands are flushed before the socket closes, falling
 * back to a hard disconnect if QUIT fails. Safe to call multiple times and with
 * already-closed or missing clients, so the shutdown coordinator can invoke it
 * idempotently.
 *
 * @param {import('ioredis').Redis|null|undefined} connection
 * @returns {Promise<void>}
 */
const closeRedisConnection = async (connection) => {
  if (!connection) {
    return;
  }

  // ioredis exposes status: 'wait' | 'connecting' | 'connect' | 'ready' |
  // 'close' | 'reconnecting' | 'end'. 'end' means the client is fully closed.
  if (connection.status === 'end') {
    return;
  }

  try {
    await connection.quit();
  } catch (error) {
    // QUIT can fail if the connection is already broken; ensure the socket is
    // torn down so we do not leak handles during shutdown.
    try {
      connection.disconnect();
    } catch (_disconnectError) {
      // Ignore: the client is already unusable.
    }
  }
};

module.exports = {
  createRedisConnection,
  closeRedisConnection,
  buildRedisOptions,
  attachConnectionHandlers,
  DEFAULT_REDIS_URL,
  DEFAULT_RETRY_STRATEGY,
  DEFAULT_MAX_RETRIES_PER_REQUEST,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_ENABLE_OFFLINE_QUEUE,
};