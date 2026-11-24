const express = require('express');
const router = express.Router();
const db = require('../db');
const poolMonitor = require('../db-pool-monitor');

const POOL_WARN_THRESHOLD = Number(process.env.POOL_WARN_THRESHOLD ?? 5);

// Canary rollout configuration. These values define the traffic share, the
// evaluation window, and the user-visible thresholds that gate promotion.
const CANARY_VERSION = process.env.CANARY_VERSION ?? process.env.APP_VERSION ?? 'unknown';
const CANARY_TRAFFIC_SHARE = Number(process.env.CANARY_TRAFFIC_SHARE ?? 0);
const CANARY_EVALUATION_WINDOW_MS = Number(process.env.CANARY_EVALUATION_WINDOW_MS ?? 300000);
const CANARY_ERROR_RATE_THRESHOLD = Number(process.env.CANARY_ERROR_RATE_THRESHOLD ?? 0.01);
const CANARY_LATENCY_P95_THRESHOLD_MS = Number(process.env.CANARY_LATENCY_P95_THRESHOLD_MS ?? 500);

// In-memory canary metrics store. The deploy script polls the canary health
// endpoint during the evaluation window; the store is updated by request
// instrumentation (see recordCanaryRequest) and can be reset per rollout.
const canaryState = {
  version: CANARY_VERSION,
  trafficShare: CANARY_TRAFFIC_SHARE,
  evaluationWindowMs: CANARY_EVALUATION_WINDOW_MS,
  errorRateThreshold: CANARY_ERROR_RATE_THRESHOLD,
  latencyP95ThresholdMs: CANARY_LATENCY_P95_THRESHOLD_MS,
  startedAt: null,
  requests: 0,
  errors: 0,
  latencies: [],
};

const MAX_LATENCY_SAMPLES = 1000;

function resetCanaryState(overrides = {}) {
  canaryState.version = overrides.version ?? CANARY_VERSION;
  canaryState.trafficShare = overrides.trafficShare ?? CANARY_TRAFFIC_SHARE;
  canaryState.evaluationWindowMs = overrides.evaluationWindowMs ?? CANARY_EVALUATION_WINDOW_MS;
  canaryState.errorRateThreshold = overrides.errorRateThreshold ?? CANARY_ERROR_RATE_THRESHOLD;
  canaryState.latencyP95ThresholdMs =
    overrides.latencyP95ThresholdMs ?? CANARY_LATENCY_P95_THRESHOLD_MS;
  canaryState.startedAt = overrides.startedAt ?? null;
  canaryState.requests = 0;
  canaryState.errors = 0;
  canaryState.latencies = [];
}

function recordCanaryRequest({ latencyMs, isError }) {
  if (canaryState.startedAt === null) {
    canaryState.startedAt = Date.now();
  }
  canaryState.requests += 1;
  if (isError) {
    canaryState.errors += 1;
  }
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
    canaryState.latencies.push(latencyMs);
    if (canaryState.latencies.length > MAX_LATENCY_SAMPLES) {
      canaryState.latencies.shift();
    }
  }
}

function computeErrorRate() {
  if (canaryState.requests === 0) {
    return 0;
  }
  return canaryState.errors / canaryState.requests;
}

function computeLatencyP95() {
  const samples = canaryState.latencies;
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function evaluateCanary() {
  const errorRate = computeErrorRate();
  const latencyP95 = computeLatencyP95();
  const breaches = [];

  if (errorRate > canaryState.errorRateThreshold) {
    breaches.push('error_rate');
  }
  if (latencyP95 > canaryState.latencyP95ThresholdMs) {
    breaches.push('latency_p95');
  }

  const now = Date.now();
  const windowElapsedMs = canaryState.startedAt === null ? 0 : now - canaryState.startedAt;
  const windowComplete = windowElapsedMs >= canaryState.evaluationWindowMs;

  let status = 'evaluating';
  if (breaches.length > 0) {
    status = 'rollback';
  } else if (windowComplete) {
    status = 'promote';
  }

  return {
    status,
    breaches,
    errorRate,
    latencyP95,
    windowElapsedMs,
    windowComplete,
  };
}

router.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    database: 'unknown',
    pool: {
      waitingQueries: 0,
      threshold: POOL_WARN_THRESHOLD,
    },
  };

  try {
    await db.query('SELECT 1');
    health.database = 'ok';
  } catch (err) {
    health.status = 'error';
    health.database = 'unreachable';
    return res.status(503).json(health);
  }

  const waitingQueries = poolMonitor.getMetric('db_pool_queries_waiting');
  health.pool.waitingQueries = waitingQueries;

  if (waitingQueries > POOL_WARN_THRESHOLD) {
    health.status = 'error';
    health.pool.saturated = true;
    return res.status(503).json(health);
  }

  return res.status(200).json(health);
});

router.get('/health/canary', (req, res) => {
  const evaluation = evaluateCanary();

  const canary = {
    version: canaryState.version,
    trafficShare: canaryState.trafficShare,
    evaluationWindowMs: canaryState.evaluationWindowMs,
    errorRate: evaluation.errorRate,
    errorRateThreshold: canaryState.errorRateThreshold,
    latencyP95: evaluation.latencyP95,
    latencyP95ThresholdMs: canaryState.latencyP95ThresholdMs,
    requests: canaryState.requests,
    errors: canaryState.errors,
    windowElapsedMs: evaluation.windowElapsedMs,
    windowComplete: evaluation.windowComplete,
    status: evaluation.status,
    breaches: evaluation.breaches,
  };

  // A rollback decision is a user-visible failure: surface it as 503 so the
  // deploy script halts promotion and triggers automated rollback.
  if (evaluation.status === 'rollback') {
    return res.status(503).json({ status: 'error', canary });
  }

  return res.status(200).json({ status: 'ok', canary });
});

module.exports = router;
module.exports.recordCanaryRequest = recordCanaryRequest;
module.exports.resetCanaryState = resetCanaryState;
module.exports.evaluateCanary = evaluateCanary;
module.exports.canaryState = canaryState;