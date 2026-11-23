const IORedis = require('ioredis');

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

const createRedisConnection = () => {
  return new IORedis(process.env.REDIS_URL || DEFAULT_REDIS_URL, {
    // BullMQ workers require blocking Redis commands to wait indefinitely.
    maxRetriesPerRequest: null,
  });
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
  DEFAULT_REDIS_URL,
};