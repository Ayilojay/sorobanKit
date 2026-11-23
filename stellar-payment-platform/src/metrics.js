const client = require('prom-client');
const { getPoolMetrics } = require('./db-pool-monitor');

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'stellar_tags_' });

// Custom counter: total HTTP requests by method, route, status
const httpRequestCounter = new client.Counter({
  name: 'stellar_tags_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Custom histogram: request duration in seconds, bucketed for SLO work
// (10ms, 50ms, 100ms, 500ms, 1s, 5s) so p50/p95/p99 latency can be derived.
const httpRequestDuration = new client.Histogram({
  name: 'stellar_tags_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
});

// The Prisma and Redis clients are created after this module is imported, so
// they are registered later via setMetricsSources and read at scrape time.
let prismaSource = null;
let redisSource = null;

/**
 * Registers the live clients the connection gauges report on. Passing a null
 * client (e.g. Redis with no REDIS_URL) leaves its gauge reporting zero.
 */
function setMetricsSources({ prisma, redisClient } = {}) {
  if (prisma !== undefined) prismaSource = prisma;
  if (redisClient !== undefined) redisSource = redisClient;
}

const EMPTY_POOL = { active: 0, idle: 0, size: 0, waiters: 0 };

// Every pool gauge needs the same snapshot, and prom-client collects them
// concurrently within one scrape. Sharing the in-flight promise keeps that to a
// single $metrics.json() call per scrape instead of one per gauge.
let inFlightPoolRead = null;

function readPoolMetrics() {
  if (!prismaSource) {
    return Promise.resolve(EMPTY_POOL);
  }

  if (!inFlightPoolRead) {
    inFlightPoolRead = getPoolMetrics(prismaSource)
      .then((metrics) => metrics || EMPTY_POOL)
      .finally(() => {
        inFlightPoolRead = null;
      });
  }

  return inFlightPoolRead;
}

// Gauge: database connections currently open in the Prisma pool
const dbPoolConnectionsOpen = new client.Gauge({
  name: 'stellar_tags_db_pool_connections_open',
  help: 'Database connections currently open in the Prisma pool',
  async collect() {
    this.set((await readPoolMetrics()).size);
  },
});

// Gauge: open connections currently executing a query
const dbPoolConnectionsBusy = new client.Gauge({
  name: 'stellar_tags_db_pool_connections_busy',
  help: 'Database connections currently executing a query',
  async collect() {
    this.set((await readPoolMetrics()).active);
  },
});

// Gauge: open connections not currently in use
const dbPoolConnectionsIdle = new client.Gauge({
  name: 'stellar_tags_db_pool_connections_idle',
  help: 'Database connections open but not currently in use',
  async collect() {
    this.set((await readPoolMetrics()).idle);
  },
});

// Gauge: queries queued because every pooled connection is busy
const dbPoolQueriesWaiting = new client.Gauge({
  name: 'stellar_tags_db_pool_queries_waiting',
  help: 'Queries queued waiting for a free database connection',
  async collect() {
    this.set((await readPoolMetrics()).waiters);
  },
});

// Gauge: the shared Redis client holds a single connection, so this reports 1
// while that connection is ready for commands and 0 otherwise.
const redisConnectionsActive = new client.Gauge({
  name: 'stellar_tags_redis_connections_active',
  help: 'Redis connections ready to accept commands (0 when unconfigured or disconnected)',
  collect() {
    this.set(redisSource?.isReady ? 1 : 0);
  },
});

// ---------------------------------------------------------------------------
// Large administrative export jobs
//
// Exports run as durable background jobs with bounded worker concurrency. The
// metrics below let operators watch job health (creation, terminal outcomes,
// queue depth vs. running workers) and artifact sizes without scraping the
// database.
// ---------------------------------------------------------------------------

// Counter: export jobs by lifecycle transition. `status` is one of
// created | completed | failed | cancelled | expired.
const exportJobsCounter = new client.Counter({
  name: 'stellar_tags_export_jobs_total',
  help: 'Total number of administrative export jobs by lifecycle status',
  labelNames: ['status'],
});

// Gauge: export jobs currently executing on a worker (bounded by the worker
// concurrency limit) and jobs waiting in the queue.
const exportJobsRunning = new client.Gauge({
  name: 'stellar_tags_export_jobs_running',
  help: 'Administrative export jobs currently running on a worker',
});

const exportJobsQueued = new client.Gauge({
  name: 'stellar_tags_export_jobs_queued',
  help: 'Administrative export jobs waiting to be picked up by a worker',
});

// Histogram: wall-clock duration of export jobs in seconds, from start of
// processing to terminal state. Buckets span short exports through multi-minute
// large exports.
const exportJobDuration = new client.Histogram({
  name: 'stellar_tags_export_job_duration_seconds',
  help: 'Administrative export job duration in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
});

// Histogram: size of the produced export artifact in bytes, so operators can
// see how large exports grow and size artifact storage accordingly.
const exportArtifactSize = new client.Histogram({
  name: 'stellar_tags_export_artifact_size_bytes',
  help: 'Size of produced administrative export artifacts in bytes',
  buckets: [
    1024,
    10 * 1024,
    100 * 1024,
    1024 * 1024,
    10 * 1024 * 1024,
    100 * 1024 * 1024,
    1024 * 1024 * 1024,
  ],
});

const EXPORT_JOB_STATUSES = ['created', 'completed', 'failed', 'cancelled', 'expired'];

/**
 * Records an export job lifecycle transition. Unknown statuses are ignored so a
 * stray value can never create unbounded label cardinality.
 */
function recordExportJobStatus(status) {
  if (!EXPORT_JOB_STATUSES.includes(status)) return;
  exportJobsCounter.inc({ status });
}

/**
 * Records the terminal duration of an export job. `status` should be one of
 * completed | failed | cancelled.
 */
function observeExportJobDuration(status, seconds) {
  if (!EXPORT_JOB_STATUSES.includes(status)) return;
  if (!Number.isFinite(seconds) || seconds < 0) return;
  exportJobDuration.observe({ status }, seconds);
}

/**
 * Records the size of a produced export artifact in bytes.
 */
function observeExportArtifactSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  exportArtifactSize.observe(bytes);
}

/**
 * Updates the running/queued export job gauges. Values are clamped to
 * non-negative numbers so a transient bad read cannot poison the gauges.
 */
function setExportJobQueueDepth({ running, queued } = {}) {
  if (running !== undefined) {
    exportJobsRunning.set(Number.isFinite(running) && running > 0 ? running : 0);
  }
  if (queued !== undefined) {
    exportJobsQueued.set(Number.isFinite(queued) && queued > 0 ? queued : 0);
  }
}

/**
 * Express middleware that tracks request count and latency.
 * Attach to app BEFORE route handlers.
 */
function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    // Normalize the route label: use the matched route template from
    // req.route.path (e.g. "/users/:username/activity") so concrete parameter
    // values never become label values, include the router mount prefix
    // (e.g. "/api/v1"), and collapse unmatched/404 paths to "unknown" so label
    // cardinality stays bounded even under arbitrary-path probing.
    const route = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : 'unknown';
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestCounter.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  next();
}

/**
 * Returns Prometheus-format metrics as a string.
 */
async function getMetrics() {
  return client.register.metrics();
}

/**
 * Returns the content type for Prometheus scraping.
 */
function getContentType() {
  return client.register.contentType;
}

module.exports = {
  metricsMiddleware,
  getMetrics,
  getContentType,
  setMetricsSources,
  dbPoolConnectionsOpen,
  dbPoolConnectionsBusy,
  dbPoolConnectionsIdle,
  dbPoolQueriesWaiting,
  redisConnectionsActive,
  exportJobsCounter,
  exportJobsRunning,
  exportJobsQueued,
  exportJobDuration,
  exportArtifactSize,
  recordExportJobStatus,
  observeExportJobDuration,
  observeExportArtifactSize,
  setExportJobQueueDepth,
};
