'use strict';

const express = require('express');
const { prisma } = require('../../../prismaClient');
const { logger } = require('../../logger');
const { ApiError } = require('../../errors');
const { HORIZON_BASE } = require('../../services/stellarService');
const { isReady } = require('../../shutdown');
const { getCanaryStatus } = require('../../services/canaryService');

const DEFAULT_HORIZON_TIMEOUT_MS = 3000;

function getHorizonTimeoutMs() {
  const parsed = parseInt(process.env.HEALTH_HORIZON_TIMEOUT_MS, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HORIZON_TIMEOUT_MS;
}

async function pingHorizon() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getHorizonTimeoutMs());
  try {
    const res = await fetch(HORIZON_BASE, { signal: controller.signal });
    if (!res.ok) throw new Error(`Horizon responded with ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

const STARTUP_CACHE_TTL_MS = 5000;

module.exports = (redisClient) => {
  const router = express.Router();

  // Tracks whether one-time initialization (DB migrations, Redis connect,
  // Horizon reachability) has completed. Cached so probes stay cheap.
  let startupState = { ready: false, checkedAt: 0, checks: null };

  async function checkDatabaseMigrations() {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS pending
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    `;
    const pending = Array.isArray(rows) && rows[0] ? Number(rows[0].pending) : 0;
    if (pending > 0) throw new Error(`${pending} pending migration(s)`);
  }

  async function checkRedisConnected() {
    if (!redisClient) return;
    const pong = await redisClient.ping();
    if (pong !== 'PONG' && pong !== 'pong') {
      throw new Error('Redis did not respond to PING');
    }
  }

  async function runStartupChecks() {
    const checks = { database: null, redis: null, horizon: null };
    const failures = [];

    const check = async (key, label, probe) => {
      try {
        await probe();
        checks[key] = 'up';
      } catch (err) {
        checks[key] = 'down';
        failures.push({ field: key, message: `${label} unavailable` });
        logger.error(err, `${label} startup check failed`);
      }
    };

    if (!redisClient) checks.redis = 'not configured';

    await Promise.all([
      check('database', 'Database', checkDatabaseMigrations),
      ...(redisClient ? [check('redis', 'Redis', checkRedisConnected)] : []),
      check('horizon', 'Horizon', pingHorizon),
    ]);

    return { checks, failures };
  }

  // Startup probe: 200 only once initialization has fully completed.
  router.get('/health/startup', async (req, res, next) => {
    const now = Date.now();
    if (!startupState.ready && now - startupState.checkedAt < STARTUP_CACHE_TTL_MS) {
      return res.status(503).json({
        status: 'STARTING',
        timestamp: new Date().toISOString(),
        ...(startupState.checks || {}),
      });
    }

    const { checks, failures } = await runStartupChecks();
    startupState = { ready: failures.length === 0, checkedAt: now, checks };

    if (failures.length) {
      return next(
        new ApiError(
          'SERVICE_UNAVAILABLE',
          'Service initialization has not completed',
          { details: failures },
        ),
      );
    }

    return res.status(200).json({
      status: 'STARTED',
      timestamp: new Date().toISOString(),
      ...checks,
    });
  });

  // Liveness probe: process/event-loop liveness only, no dependency checks.
  router.get('/health/live', (req, res) => {
    const mem = process.memoryUsage();
    return res.status(200).json({
      status: 'ALIVE',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
    });
  });

  // Readiness probe: only dependencies that affect request routing.
  router.get('/health/ready', async (req, res, next) => {
    const checks = { database: null, redis: null };
    const failures = [];

    const check = async (key, label, probe) => {
      try {
        await probe();
        checks[key] = 'up';
      } catch (err) {
        checks[key] = 'down';
        failures.push({ field: key, message: `${label} unavailable` });
        logger.error(err, `[Correlation ID: ${req.correlationId}] ${label} readiness check failed`);
      }
    };

    if (!redisClient) checks.redis = 'not configured';

    await Promise.all([
      check('database', 'Database', () => prisma.$queryRaw`SELECT 1`),
      ...(redisClient ? [check('redis', 'Redis', () => redisClient.ping())] : []),
    ]);

    if (failures.length) {
      return next(
        new ApiError(
          'SERVICE_UNAVAILABLE',
          'Service is not ready to receive traffic',
          { details: failures },
        ),
      );
    }

    return res.status(200).json({
      status: 'READY',
      timestamp: new Date().toISOString(),
      ...checks,
    });
  });

  // Canary status probe: exposes the running version plus the user-visible
  // indicators (error rate, latency p95) and the canary traffic share so the
  // deploy script can poll and decide whether to promote or roll back.
  router.get('/health/canary', (req, res) => {
    const status = getCanaryStatus();
    return res.status(200).json({
      status: status.rolledBack ? 'ROLLED_BACK' : status.promoted ? 'PROMOTED' : 'CANARY',
      timestamp: new Date().toISOString(),
      version: status.version,
      canaryShare: status.canaryShare,
      errorRate: status.errorRate,
      latencyP95Ms: status.latencyP95Ms,
      sampleCount: status.sampleCount,
      windowMs: status.windowMs,
      thresholds: status.thresholds,
      breached: status.breached,
      manualOverride: status.manualOverride,
      rolledBack: status.rolledBack,
      promoted: status.promoted,
    });
  });

  router.get('/health', async (req, res, next) => {
    // Once the shutdown coordinator flips readiness to false, report DRAINING so
    // load balancers stop routing new traffic while in-flight requests finish.
    if (!isReady()) {
      return res.status(503).json({
        status: 'DRAINING',
        timestamp: new Date().toISOString(),
        database: null,
        redis: null,
        horizon: null,
      });
    }

    const checks = { database: null, redis: null, horizon: null };
    const failures = [];

    const check = async (key, label, probe) => {
      try {
        await probe();
        checks[key] = 'up';
      } catch (err) {
        checks[key] = 'down';
        failures.push({ field: key, message: `${label} unavailable` });
        logger.error(err, `[Correlation ID: ${req.correlationId}] ${label} health check failed`);
      }
    };

    if (!redisClient) checks.redis = 'not configured';

    await Promise.all([
      check('database', 'Database', () => prisma.$queryRaw`SELECT 1`),
      ...(redisClient ? [check('redis', 'Redis', () => redisClient.ping())] : []),
      check('horizon', 'Horizon', pingHorizon),
    ]);

    const response = {
      status: failures.length ? 'DOWN' : 'UP',
      timestamp: new Date().toISOString(),
      ...checks,
    };

    if (failures.length) {
      return next(
        new ApiError(
          'SERVICE_UNAVAILABLE',
          'One or more health checks are unavailable',
          { details: failures },
        ),
      );
    }

    return res.status(200).json(response);
  });

  return router;
};
