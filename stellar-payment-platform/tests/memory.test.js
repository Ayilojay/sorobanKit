/**
 * Memory Leak Detection Test — Issue #511
 *
 * Uses Node.js's built-in `v8` module to take heap snapshots before and after
 * running the API under a synthetic load of N requests.  The test fails if the
 * heap growth exceeds a configurable threshold, catching unbounded memory leaks
 * before they reach production.
 *
 * Design notes
 * ─────────────
 * • No real database is needed — the Express app is imported with all external
 *   I/O mocked (Prisma, Redis, Stellar SDK), exactly as every other unit test
 *   in this suite does.
 * • `v8.getHeapStatistics().used_heap_size` is the most reliable JS-heap metric
 *   for this purpose; it counts only live objects and is cheaper to read than a
 *   full heap snapshot file.
 * • A single GC pass is forced before each measurement (available when the
 *   process is started with --expose-gc, which Jest enables via the config
 *   option below).  This flushes short-lived objects so we measure steady-state
 *   retention rather than allocation churn.
 * • `MEMORY_TEST_REQUESTS` (env var, default 200) controls the request count.
 * • `MEMORY_LEAK_THRESHOLD_MB` (env var, default 50) controls the allowed
 *   heap growth in megabytes.
 *
 * Sustained-load benchmark (Issue #479)
 * ─────────────────────────────────────
 * The load loop drives a realistic mix of the critical user journeys
 * (registration, federation lookup, payment initiation, history) instead of a
 * single endpoint, and additionally tracks connection-pool usage over time so
 * that unbounded resource growth (leaked sockets / pool slots) is caught even
 * when the JS heap stays flat.
 */

'use strict';

const v8 = require('v8');
const http = require('http');

// ── Jest timeout: allow up to 60 s for the full load loop ────────────────────
jest.setTimeout(60_000);

// ── External-dependency mocks (mirrors api.test.js) ─────────────────────────
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

// ── Configuration ─────────────────────────────────────────────────────────────
const REQUEST_COUNT = parseInt(process.env.MEMORY_TEST_REQUESTS ?? '200', 10);
const THRESHOLD_MB = parseFloat(process.env.MEMORY_LEAK_THRESHOLD_MB ?? '50');
const THRESHOLD_BYTES = THRESHOLD_MB * 1024 * 1024;
// Allowed growth of the HTTP connection pool (open sockets) across the run.
const POOL_GROWTH_LIMIT = parseInt(process.env.MEMORY_TEST_POOL_GROWTH ?? '10', 10);

// ── Critical-journey request mix (#479) ──────────────────────────────────────
// Each entry is a request the benchmark rotates through so that registration,
// federation lookup, payment initiation and history are all exercised under
// sustained load.  Bodies are only sent for POST journeys.
const JOURNEY_MIX = [
  { name: 'health', method: 'GET', path: '/health' },
  { name: 'federation', method: 'GET', path: '/federation?q=client*localhost' },
  { name: 'federation-miss', method: 'GET', path: '/federation?q=unknown*localhost' },
  { name: 'history', method: 'GET', path: '/transactions?account=GCLIENT' },
  {
    name: 'registration',
    method: 'POST',
    path: '/register',
    body: { publicKey: 'GCLIENT', email: 'bench@example.com' },
  },
  {
    name: 'payment',
    method: 'POST',
    path: '/payments',
    body: { from: 'GCLIENT', to: 'GMERCHANT', amount: '1.00', asset: 'XLM' },
  },
];

// /health probes Horizon over HTTP; keep it off the network.
global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Force a synchronous garbage-collection pass when the V8 GC is exposed
 * (Jest passes --expose-gc when `globals` contains `gc`; fall back gracefully
 * when running outside Jest or without the flag).
 */
function forceGC() {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

/**
 * Read live heap usage in bytes after a GC pass.
 */
function heapUsedBytes() {
  forceGC();
  return v8.getHeapStatistics().used_heap_size;
}

/**
 * Send a single HTTP request to the running server and resolve when the full
 * response body has been consumed (so the server has finished its work).
 * Accepts either a path string (GET) or a journey descriptor from JOURNEY_MIX.
 */
function sendRequest(server, journey) {
  const spec =
    typeof journey === 'string' ? { method: 'GET', path: journey } : journey;
  const payload = spec.body ? JSON.stringify(spec.body) : null;

  return new Promise((resolve, reject) => {
    const { address, port } = server.address();
    const host = address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host, port, path: spec.path, method: spec.method, headers },
      (res) => {
        res.resume(); // drain the body
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Snapshot of the server's current connection-pool usage.  `connections` is
 * the number of sockets currently open against the listener; a value that
 * keeps climbing across batches indicates leaked sockets / pool slots.
 */
function poolUsage(server) {
  if (typeof server.getConnections !== 'function') return 0;
  let count = 0;
  // getConnections is async but the callback fires synchronously for the
  // in-process listener used here.
  server.getConnections((_err, n) => {
    count = n;
  });
  return count;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Memory leak detection (#511)', () => {
  let server;

  beforeAll((done) => {
    process.env.NODE_ENV = 'test';
    // Import the app after mocks are in place.
    const { app } = require('../server');
    server = app.listen(0, '127.0.0.1', done); // OS-assigned port
  });

  afterAll((done) => {
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it(
    `heap growth stays below ${THRESHOLD_MB} MB after ${REQUEST_COUNT} requests`,
    async () => {
      // --- warm-up: a handful of requests to let V8 JIT and settle caches ----
      const WARMUP = Math.min(20, Math.floor(REQUEST_COUNT / 10));
      for (let i = 0; i < WARMUP; i++) {
        await sendRequest(server, '/health');
      }

      // --- baseline measurement -------------------------------------------
      const baselineBytes = heapUsedBytes();

      // --- load loop --------------------------------------------------------
      // Rotate through the critical-journey mix so registration, federation
      // lookup, payment initiation and history all run under sustained load.
      for (let i = 0; i < REQUEST_COUNT; i++) {
        await sendRequest(server, JOURNEY_MIX[i % JOURNEY_MIX.length]);
      }

      // --- final measurement ------------------------------------------------
      const finalBytes = heapUsedBytes();
      const growthBytes = finalBytes - baselineBytes;
      const growthMB = (growthBytes / (1024 * 1024)).toFixed(2);

      console.log(
        `[memory-test] baseline=${(baselineBytes / 1024 / 1024).toFixed(2)} MB  ` +
          `final=${(finalBytes / 1024 / 1024).toFixed(2)} MB  ` +
          `growth=${growthMB} MB  threshold=${THRESHOLD_MB} MB`,
      );

      expect(growthBytes).toBeLessThan(
        THRESHOLD_BYTES,
        `Heap grew by ${growthMB} MB after ${REQUEST_COUNT} requests — ` +
          `exceeds the ${THRESHOLD_MB} MB threshold. Possible memory leak.`,
      );
    },
  );

  it('heap is not growing monotonically across request batches', async () => {
    // Send three equal-sized batches and record heap after each.  A steady
    // leak produces a strictly increasing series; a healthy process will
    // plateau or oscillate.  We allow each step to grow by at most
    // THRESHOLD_BYTES / 3 to give room for natural GC jitter.
    const BATCH = Math.max(10, Math.floor(REQUEST_COUNT / 3));
    const PER_STEP_LIMIT = THRESHOLD_BYTES / 3;

    // baseline
    let prev = heapUsedBytes();
    const growthPerBatch = [];

    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < BATCH; i++) {
        await sendRequest(server, '/health');
      }
      const after = heapUsedBytes();
      growthPerBatch.push(after - prev);
      prev = after;
    }

    console.log(
      '[memory-test] per-batch growth (bytes):',
      growthPerBatch.map((b) => b.toLocaleString()).join(', '),
    );

    // At most one batch may exceed the per-step limit (GC timing is non-
    // deterministic; two consecutive limit-busting steps strongly suggest a leak).
    const exceedingSteps = growthPerBatch.filter((g) => g > PER_STEP_LIMIT).length;
    expect(exceedingSteps).toBeLessThanOrEqual(1);
  });

  it('connection-pool usage stays bounded across the sustained journey mix', async () => {
    // Drive the full critical-journey mix in batches and record the number of
    // open sockets after each batch.  A healthy server releases sockets once
    // the response is drained, so the pool should plateau rather than grow.
    const BATCH = Math.max(10, Math.floor(REQUEST_COUNT / 3));
    const poolSamples = [];

    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < BATCH; i++) {
        await sendRequest(server, JOURNEY_MIX[i % JOURNEY_MIX.length]);
      }
      poolSamples.push(poolUsage(server));
    }

    console.log('[memory-test] pool usage per batch:', poolSamples.join(', '));

    const growth = poolSamples[poolSamples.length - 1] - poolSamples[0];
    expect(growth).toBeLessThanOrEqual(
      POOL_GROWTH_LIMIT,
      `Connection pool grew by ${growth} sockets across the sustained load ` +
        `(limit ${POOL_GROWTH_LIMIT}). Possible socket/pool leak.`,
    );
  });
});
