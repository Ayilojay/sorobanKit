'use strict';

/**
 * Migration runner with cross-replica serialization (issue #388).
 *
 * Production deployments may start several replicas at once. Running
 * `prisma migrate deploy` concurrently from multiple replicas can cause
 * duplicate/conflicting DDL and spurious failures. To serialize migration
 * execution we acquire a bounded PostgreSQL advisory lock before running
 * migrations and release it afterwards (even on failure).
 *
 * The lock is a session-level advisory lock held on a dedicated pg
 * connection. We use `pg_try_advisory_lock` in a retry loop so that waiting
 * is bounded by MIGRATION_LOCK_TIMEOUT_MS instead of blocking indefinitely.
 */

const { spawn } = require('child_process');
const logger = require('./logger');

/**
 * Advisory lock key used to serialize migrations across replicas.
 * Must be a stable 64-bit-safe integer (we use a 32-bit int here).
 */
const MIGRATION_LOCK_KEY = 388001;

/** Default time to wait for the advisory lock before giving up (ms). */
const DEFAULT_LOCK_TIMEOUT_MS = 120000;

/** Default interval between lock acquisition attempts (ms). */
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 1000;

/** Default timeout for the `prisma migrate deploy` child process (ms). */
const DEFAULT_MIGRATION_TIMEOUT_MS = 600000;

const DEFAULT_PRISMA_COMMAND = 'npx';
const DEFAULT_PRISMA_ARGS = ['prisma', 'migrate', 'deploy'];

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveConfig(overrides = {}) {
  const env = process.env;
  return {
    lockKey: overrides.lockKey ?? MIGRATION_LOCK_KEY,
    lockTimeoutMs:
      overrides.lockTimeoutMs ??
      parsePositiveInt(env.MIGRATION_LOCK_TIMEOUT_MS, DEFAULT_LOCK_TIMEOUT_MS),
    lockRetryIntervalMs:
      overrides.lockRetryIntervalMs ??
      parsePositiveInt(
        env.MIGRATION_LOCK_RETRY_INTERVAL_MS,
        DEFAULT_LOCK_RETRY_INTERVAL_MS
      ),
    migrationTimeoutMs:
      overrides.migrationTimeoutMs ??
      parsePositiveInt(
        env.MIGRATION_TIMEOUT_MS,
        DEFAULT_MIGRATION_TIMEOUT_MS
      ),
    databaseUrl: overrides.databaseUrl ?? env.DATABASE_URL,
    prismaCommand: overrides.prismaCommand ?? DEFAULT_PRISMA_COMMAND,
    prismaArgs: overrides.prismaArgs ?? DEFAULT_PRISMA_ARGS,
    logger: overrides.logger ?? logger,
    // Injectable for tests.
    createClient: overrides.createClient,
    runPrisma: overrides.runPrisma,
    sleep: overrides.sleep,
    now: overrides.now,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultCreateClient(databaseUrl) {
  // Lazy require so tests can inject a mock without needing `pg` installed.
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  return new Client({ connectionString: databaseUrl });
}

/**
 * Run `prisma migrate deploy` as a child process.
 * Resolves with { code, stdout, stderr }; rejects on spawn error or timeout.
 */
function defaultRunPrisma({ command, args, timeoutMs, logger: log }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_err) {
          // ignore
        }
        const err = new Error(
          `prisma migrate deploy timed out after ${timeoutMs}ms`
        );
        err.code = 'MIGRATION_TIMEOUT';
        finish(reject, err);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    child.on('error', (err) => {
      finish(reject, err);
    });

    child.on('close', (code) => {
      if (log && stdout) {
        log.info('migration.prisma.output', { stream: 'stdout', output: stdout });
      }
      if (log && stderr) {
        log.info('migration.prisma.output', { stream: 'stderr', output: stderr });
      }
      finish(resolve, { code, stdout, stderr });
    });
  });
}

/**
 * Acquire the advisory lock, retrying until timeout.
 * Returns true if acquired, false if timed out.
 */
async function acquireLock(client, config) {
  const { lockKey, lockTimeoutMs, lockRetryIntervalMs, logger: log, sleep, now } = config;
  const clock = now || Date.now;
  const wait = sleep || defaultSleep;
  const startedAt = clock();
  let attempts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [
      lockKey,
    ]);
    const locked = Boolean(result && result.rows && result.rows[0] && result.rows[0].locked);

    if (locked) {
      log.info('migration.lock.acquired', {
        lockKey,
        attempts,
        waitedMs: clock() - startedAt,
      });
      return true;
    }

    const elapsed = clock() - startedAt;
    if (elapsed >= lockTimeoutMs) {
      log.error('migration.lock.timeout', {
        lockKey,
        attempts,
        waitedMs: elapsed,
        lockTimeoutMs,
      });
      return false;
    }

    log.info('migration.lock.waiting', {
      lockKey,
      attempts,
      waitedMs: elapsed,
      lockTimeoutMs,
    });

    const remaining = lockTimeoutMs - elapsed;
    const delay = Math.min(lockRetryIntervalMs, remaining);
    await wait(delay);
  }
}

async function releaseLock(client, config) {
  const { lockKey, logger: log } = config;
  try {
    const result = await client.query(
      'SELECT pg_advisory_unlock($1) AS unlocked',
      [lockKey]
    );
    const unlocked = Boolean(
      result && result.rows && result.rows[0] && result.rows[0].unlocked
    );
    log.info('migration.lock.released', { lockKey, unlocked });
    return unlocked;
  } catch (err) {
    log.error('migration.lock.release_failed', {
      lockKey,
      error: err && err.message ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Run migrations under a cross-replica advisory lock.
 *
 * @param {object} [overrides] Optional overrides (used primarily by tests).
 * @returns {Promise<{status: string, code?: number}>}
 */
async function runMigrations(overrides = {}) {
  const config = resolveConfig(overrides);
  const log = config.logger;
  const createClient = config.createClient || defaultCreateClient;
  const runPrisma = config.runPrisma || defaultRunPrisma;

  if (!config.databaseUrl) {
    log.error('migration.failed', { reason: 'DATABASE_URL is not set' });
    throw new Error('DATABASE_URL is not set; cannot run migrations');
  }

  log.info('migration.start', {
    lockKey: config.lockKey,
    lockTimeoutMs: config.lockTimeoutMs,
  });

  const client = createClient(config.databaseUrl);
  let lockAcquired = false;

  try {
    await client.connect();
    log.info('migration.lock.connecting', { lockKey: config.lockKey });

    lockAcquired = await acquireLock(client, config);
    if (!lockAcquired) {
      const err = new Error(
        `Timed out after ${config.lockTimeoutMs}ms waiting for migration lock`
      );
      err.code = 'MIGRATION_LOCK_TIMEOUT';
      log.error('migration.failed', {
        reason: 'lock_timeout',
        lockKey: config.lockKey,
      });
      throw err;
    }

    log.info('migration.prisma.start', {
      command: config.prismaCommand,
      args: config.prismaArgs,
    });

    const result = await runPrisma({
      command: config.prismaCommand,
      args: config.prismaArgs,
      timeoutMs: config.migrationTimeoutMs,
      logger: log,
    });

    if (result.code !== 0) {
      const err = new Error(
        `prisma migrate deploy exited with code ${result.code}`
      );
      err.code = 'MIGRATION_FAILED';
      err.exitCode = result.code;
      log.error('migration.failed', {
        reason: 'prisma_exit',
        exitCode: result.code,
      });
      throw err;
    }

    log.info('migration.completed', { exitCode: result.code });
    return { status: 'success', code: result.code };
  } catch (err) {
    if (!err.code || err.code === 'MIGRATION_FAILED') {
      log.error('migration.failed', {
        reason: err.code || 'error',
        error: err && err.message ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    if (lockAcquired) {
      await releaseLock(client, config);
    }
    try {
      await client.end();
    } catch (err) {
      log.error('migration.connection.close_failed', {
        error: err && err.message ? err.message : String(err),
      });
    }
  }
}

module.exports = {
  MIGRATION_LOCK_KEY,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_RETRY_INTERVAL_MS,
  DEFAULT_MIGRATION_TIMEOUT_MS,
  runMigrations,
  // Exported for focused unit tests.
  acquireLock,
  releaseLock,
  resolveConfig,
};