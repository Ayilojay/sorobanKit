'use strict';

const { randomUUID } = require('crypto');

// Prefix shared by every record an e2e suite creates. The random suffix scopes
// records to a single run so cleanup never touches another run's data.
// Alphanumeric only and short enough to pass username validation (3-20 chars).
function e2ePrefix() {
  return `e2etest${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

// Delete every record in `store` whose username starts with `prefix`.
function purgeTestRecords(store, prefix) {
  for (const [key, row] of store.entries()) {
    if (row && typeof row.username === 'string' && row.username.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Environment guards
// ---------------------------------------------------------------------------

// Hostnames that are only ever valid inside a disposable/ephemeral stack.
// Anything else (including real production hosts) is rejected.
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'postgres',
  'redis',
  'stellar',
  'horizon',
  'db',
  'cache',
  'app',
  'api',
  'worker',
]);

// Substrings that mark a value as pointing at production infrastructure.
const PRODUCTION_MARKERS = [
  'prod',
  'production',
  'live',
  'mainnet',
  'public',
];

// Environment variable names that must never carry production credentials
// into a disposable test run.
const CREDENTIAL_ENV_VARS = [
  'STELLAR_SECRET_KEY',
  'STELLAR_SECRET',
  'STELLAR_ISSUER_SECRET',
  'STELLAR_DISTRIBUTION_SECRET',
  'DATABASE_URL',
  'POSTGRES_URL',
  'REDIS_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

// Parse a connection URL and return its hostname, or null when unparseable.
function hostnameOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    // Bare hostnames (e.g. "postgres") are not valid URLs, so try with a scheme.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `tcp://${value}`;
    return new URL(withScheme).hostname || null;
  } catch (_err) {
    return null;
  }
}

// Throw when `value` looks like it points at production infrastructure.
function assertNotProduction(value, label = 'value') {
  if (value === undefined || value === null || value === '') return;
  const text = String(value).toLowerCase();
  for (const marker of PRODUCTION_MARKERS) {
    if (text.includes(marker)) {
      throw new Error(
        `Refusing to run e2e test: ${label} appears to reference production ("${marker}")`,
      );
    }
  }
  const host = hostnameOf(value);
  if (host && !isLoopbackHost(host) && !ALLOWED_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `Refusing to run e2e test: ${label} points at non-disposable host "${host}"`,
    );
  }
}

// Validate the whole environment before any disposable stack is touched.
// Returns the (unchanged) env so callers can chain it.
function assertDisposableEnvironment(env = process.env) {
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    assertNotProduction(value, name);
  }
  // Explicit opt-in is required so a stray CI job cannot hit shared infra.
  if (env.E2E_ALLOW_NON_DISPOSABLE === '1' || env.E2E_ALLOW_NON_DISPOSABLE === 'true') {
    throw new Error(
      'Refusing to run e2e test: E2E_ALLOW_NON_DISPOSABLE must not be set for disposable stacks',
    );
  }
  return env;
}

// ---------------------------------------------------------------------------
// Readiness polling
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll `probe` until it resolves truthy or the timeout elapses.
// `probe` may be sync or async and may throw; throws are treated as "not ready".
async function waitForReady(probe, options = {}) {
  const {
    timeoutMs = 30000,
    intervalMs = 100,
    description = 'dependency',
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let attempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      const result = await probe();
      if (result) return { ready: true, attempts, lastError: null };
    } catch (err) {
      lastError = err;
    }
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }

  const suffix = lastError ? ` (last error: ${lastError.message})` : '';
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description} to become ready${suffix}`,
  );
}

// Poll until `probe` resolves falsy (e.g. a dependency has gone away).
async function waitForUnavailable(probe, options = {}) {
  const { timeoutMs = 30000, intervalMs = 100, description = 'dependency' } = options;
  return waitForReady(
    async () => {
      try {
        return !(await probe());
      } catch (_err) {
        return true;
      }
    },
    { timeoutMs, intervalMs, description: `${description} to become unavailable` },
  );
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

// Track resources (workers, connections, servers) so a test can tear them all
// down deterministically, even when an assertion fails mid-test.
class ResourceTracker {
  constructor() {
    this._resources = [];
  }

  // Register a resource. `close` is invoked on cleanup; it may be async.
  track(resource, close) {
    const closer =
      typeof close === 'function'
        ? close
        : resource && typeof resource.close === 'function'
          ? () => resource.close()
          : resource && typeof resource.stop === 'function'
            ? () => resource.stop()
            : resource && typeof resource.disconnect === 'function'
              ? () => resource.disconnect()
              : null;
    if (!closer) {
      throw new Error('ResourceTracker.track requires a close/stop/disconnect method or closer');
    }
    this._resources.push({ resource, closer });
    return resource;
  }

  get size() {
    return this._resources.length;
  }

  // Close every tracked resource in reverse order. Never throws; returns the
  // list of errors so tests can assert on bounded cleanup.
  async cleanup() {
    const errors = [];
    while (this._resources.length > 0) {
      const { resource, closer } = this._resources.pop();
      try {
        await closer(resource);
      } catch (err) {
        errors.push(err);
      }
    }
    return errors;
  }
}

// Stop a set of worker-like objects and wait until they report inactive.
// Returns the number of workers that failed to stop.
async function stopWorkers(workers, options = {}) {
  const { timeoutMs = 10000, intervalMs = 50 } = options;
  const list = Array.from(workers || []);
  for (const worker of list) {
    if (!worker) continue;
    if (typeof worker.stop === 'function') {
      await worker.stop();
    } else if (typeof worker.close === 'function') {
      await worker.close();
    } else if (typeof worker.terminate === 'function') {
      await worker.terminate();
    }
  }

  let failures = 0;
  for (const worker of list) {
    if (!worker) continue;
    try {
      await waitForReady(
        () => {
          if (typeof worker.isActive === 'function') return !worker.isActive();
          if (typeof worker.isRunning === 'function') return !worker.isRunning();
          if (typeof worker.active === 'boolean') return !worker.active;
          return true;
        },
        { timeoutMs, intervalMs, description: 'worker to stop' },
      );
    } catch (_err) {
      failures += 1;
    }
  }
  return failures;
}

// Close a set of connection-like objects (pg clients, redis clients, pools).
async function closeConnections(connections) {
  const errors = [];
  for (const conn of Array.from(connections || [])) {
    if (!conn) continue;
    try {
      if (typeof conn.end === 'function') {
        await conn.end();
      } else if (typeof conn.quit === 'function') {
        await conn.quit();
      } else if (typeof conn.disconnect === 'function') {
        await conn.disconnect();
      } else if (typeof conn.close === 'function') {
        await conn.close();
      }
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

module.exports = {
  e2ePrefix,
  purgeTestRecords,
  assertNotProduction,
  assertDisposableEnvironment,
  isLoopbackHost,
  hostnameOf,
  sleep,
  waitForReady,
  waitForUnavailable,
  ResourceTracker,
  stopWorkers,
  closeConnections,
};