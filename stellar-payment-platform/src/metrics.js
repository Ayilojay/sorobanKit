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

// ---------------------------------------------------------------------------
// Service-level indicator (SLI) metrics.
//
// These back the SLOs documented in docs/operations/slo.md. Label sets are
// deliberately low-cardinality: only route templates, operation names, status
// classes and network identifiers are allowed. User identifiers (Stellar
// addresses, emails, usernames, intent/payment ids) must never be used as
// label values.
// ---------------------------------------------------------------------------

// Status classes collapse concrete HTTP codes so cardinality stays bounded.
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'];

/**
 * Maps an HTTP status code to a coarse status class label value.
 * Unknown codes fall back to 'unknown' rather than leaking the raw code.
 */
function statusClass(statusCode) {
  const code = Number(statusCode);
  if (!Number.isFinite(code)) return 'unknown';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return 'unknown';
}

// Counter: SLI events for the three user-facing flows. `operation` is a fixed
// enum (e.g. "register", "federation_lookup", "payment_submit") and `status`
// is a status class or outcome enum, never a user-supplied value.
const sliEventsTotal = new client.Counter({
  name: 'stellar_tags_sli_events_total',
  help: 'Service-level indicator events by flow, operation and status class',
  labelNames: ['flow', 'operation', 'status'],
});

// Histogram: end-to-end latency for SLI flows, bucketed for p50/p95/p99.
const sliLatencySeconds = new client.Histogram({
  name: 'stellar_tags_sli_latency_seconds',
  help: 'Latency in seconds for user-facing SLI flows',
  labelNames: ['flow', 'operation', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Histogram: time from payment submission to ledger finality, per network.
// `outcome` is a fixed enum: success | failed | timeout | reverted.
const ledgerFinalitySeconds = new client.Histogram({
  name: 'stellar_tags_ledger_finality_seconds',
  help: 'Time from payment submission to ledger finality, by network and outcome',
  labelNames: ['network', 'outcome'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
});

// Gauge: age in seconds of the oldest unreconciled payment intent, per network.
// Set from a periodic reconciliation sweep; never labelled by intent id.
const oldestUnreconciledIntentAgeSeconds = new client.Gauge({
  name: 'stellar_tags_oldest_unreconciled_intent_age_seconds',
  help: 'Age in seconds of the oldest unreconciled payment intent, by network',
  labelNames: ['network'],
});

/**
 * Records one SLI observation for a flow.
 * @param {object} params
 * @param {string} params.flow - e.g. "registration" | "federation" | "payment"
 * @param {string} params.operation - fixed operation enum
 * @param {string|number} params.status - status class or outcome enum
 * @param {number} [params.durationSeconds] - observed latency, if any
 */
function recordSli({ flow, operation, status, durationSeconds } = {}) {
  const labels = {
    flow: flow || 'unknown',
    operation: operation || 'unknown',
    status: typeof status === 'number' ? statusClass(status) : status || 'unknown',
  };
  sliEventsTotal.inc(labels);
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    sliLatencySeconds.observe(labels, durationSeconds);
  }
}

/**
 * Records submission-to-finality latency for a payment on a network.
 * @param {object} params
 * @param {string} params.network - network identifier (e.g. "testnet")
 * @param {string} params.outcome - success | failed | timeout | reverted
 * @param {number} params.durationSeconds - submission-to-finality duration
 */
function recordLedgerFinality({ network, outcome, durationSeconds } = {}) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
    return;
  }
  ledgerFinalitySeconds.observe(
    { network: network || 'unknown', outcome: outcome || 'unknown' },
    durationSeconds,
  );
}

/**
 * Updates the oldest-unreconciled-intent-age gauge for a network.
 * @param {object} params
 * @param {string} params.network - network identifier
 * @param {number} params.ageSeconds - age of the oldest unreconciled intent
 */
function setOldestUnreconciledIntentAge({ network, ageSeconds } = {}) {
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds)) {
    return;
  }
  oldestUnreconciledIntentAgeSeconds.set({ network: network || 'unknown' }, ageSeconds);
}

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

// --- Webhook queue health -------------------------------------------------
// These metrics back the operational dashboard for the webhook delivery queue.
// They are updated by the webhook worker / admin DLQ route via the helpers
// below rather than collected at scrape time, so a scrape never triggers a
// database query. All label values are bounded (status/outcome enums only).

// Gauge: age in seconds of the oldest webhook event still pending delivery.
// Reported as 0 when the queue is empty so the dashboard shows a flat line
// instead of a gap.
const webhookQueueOldestPendingAge = new client.Gauge({
  name: 'stellar_tags_webhook_queue_oldest_pending_age_seconds',
  help: 'Age in seconds of the oldest webhook event still pending delivery (0 when empty)',
});

// Histogram: number of delivery attempts made for an event before it was
// delivered or moved to the DLQ. Buckets are bounded to a small set of attempt
// counts so the dashboard can render an attempt distribution without
// unbounded cardinality.
const webhookDeliveryAttempts = new client.Histogram({
  name: 'stellar_tags_webhook_delivery_attempts',
  help: 'Number of delivery attempts per webhook event',
  buckets: [1, 2, 3, 5, 8, 13, 21],
});

// Histogram: end-to-end delivery latency in seconds, from event enqueue to
// successful delivery. Buckets mirror the HTTP latency SLOs plus a longer tail
// for retried deliveries.
const webhookDeliveryLatency = new client.Histogram({
  name: 'stellar_tags_webhook_delivery_latency_seconds',
  help: 'Webhook delivery latency in seconds from enqueue to successful delivery',
  buckets: [0.1, 0.5, 1, 5, 30, 60, 300],
});

// Gauge: age in seconds of the oldest event sitting in the dead-letter queue.
// Reported as 0 when the DLQ is empty.
const webhookDlqOldestAge = new client.Gauge({
  name: 'stellar_tags_webhook_dlq_oldest_age_seconds',
  help: 'Age in seconds of the oldest webhook event in the dead-letter queue (0 when empty)',
});

/**
 * Records the age of the oldest pending webhook event. Negative or non-finite
 * inputs are clamped to 0 so a clock skew never produces a misleading spike.
 */
function observeWebhookOldestPendingAge(seconds) {
  const value = Number(seconds);
  webhookQueueOldestPendingAge.set(Number.isFinite(value) && value > 0 ? value : 0);
}

/**
 * Records the age of the oldest dead-lettered webhook event, clamped like the
 * pending-age gauge.
 */
function observeWebhookDlqOldestAge(seconds) {
  const value = Number(seconds);
  webhookDlqOldestAge.set(Number.isFinite(value) && value > 0 ? value : 0);
}

/**
 * Records the attempt count and (on success) the delivery latency for a single
 * webhook event. Attempts below 1 are clamped to 1 so the histogram always
 * observes a valid bucket. Latency is only observed when provided and finite.
 */
function observeWebhookDelivery({ attempts, latencySeconds } = {}) {
  const attemptValue = Number(attempts);
  webhookDeliveryAttempts.observe(
    Number.isFinite(attemptValue) && attemptValue >= 1 ? attemptValue : 1
  );

  if (latencySeconds !== undefined && latencySeconds !== null) {
    const latencyValue = Number(latencySeconds);
    if (Number.isFinite(latencyValue) && latencyValue >= 0) {
      webhookDeliveryLatency.observe(latencyValue);
    }
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
  // SLI / SLO metrics
  STATUS_CLASSES,
  statusClass,
  recordSli,
  recordLedgerFinality,
  setOldestUnreconciledIntentAge,
  sliEventsTotal,
  sliLatencySeconds,
  ledgerFinalitySeconds,
  oldestUnreconciledIntentAgeSeconds,
};
