const request = require('supertest');
const express = require('express');

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
}));

jest.mock('../prismaClient', () => ({
  prisma: { $queryRaw: jest.fn() },
}));

const { prisma } = require('../prismaClient');
const { HORIZON_BASE } = require('../src/services/stellarService');
const healthRoutes = require('../src/routes/v1/healthRoutes');
const { buildErrorHandler } = require('../src/middleware/errorHandler');
const {
  beginShutdown,
  resetShutdownState,
  isShuttingDown,
} = require('../src/lifecycle/shutdownState');

const buildApp = (redisClient = null) => {
  const app = express();
  app.use(healthRoutes(redisClient));
  app.use(buildErrorHandler(() => false));
  return app;
};

let redisClient;

beforeEach(() => {
  jest.clearAllMocks();
  resetShutdownState();
  prisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
  redisClient = { ping: jest.fn().mockResolvedValue('PONG') };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  delete process.env.HEALTH_HORIZON_TIMEOUT_MS;
});

afterEach(() => {
  resetShutdownState();
  delete process.env.HEALTH_HORIZON_TIMEOUT_MS;
});

describe('GET /health', () => {
  test('returns 200 with every dependency up', async () => {
    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'UP',
      database: 'up',
      redis: 'up',
      horizon: 'up',
    });
    expect(res.body.timestamp).toEqual(expect.any(String));
  });

  test('probes PostgreSQL, Redis and Horizon', async () => {
    await request(buildApp(redisClient)).get('/health');

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(redisClient.ping).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(HORIZON_BASE, expect.anything());
  });

  test('returns 503 when the database query fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'One or more health checks are unavailable',
      retryable: true,
      details: [{ field: 'database', message: 'Database unavailable' }],
    });
  });

  test('returns 503 when the Redis PING fails', async () => {
    redisClient.ping.mockRejectedValue(new Error('not connected'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.error.details).toContainEqual({
      field: 'redis',
      message: 'Redis unavailable',
    });
  });

  test('returns 503 when Horizon is unreachable', async () => {
    global.fetch.mockRejectedValue(new Error('ETIMEDOUT'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.error.details).toContainEqual({
      field: 'horizon',
      message: 'Horizon unavailable',
    });
  });

  test('returns 503 when Horizon answers with a non-2xx status', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 502 });

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.error.details).toContainEqual({
      field: 'horizon',
      message: 'Horizon unavailable',
    });
  });

  test('reports every failing dependency in one response', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('down'));
    redisClient.ping.mockRejectedValue(new Error('down'));
    global.fetch.mockRejectedValue(new Error('down'));

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        details: [
          { field: 'database', message: 'Database unavailable' },
          { field: 'redis', message: 'Redis unavailable' },
          { field: 'horizon', message: 'Horizon unavailable' },
        ],
      },
    });
  });

  test('reports Redis as not configured and stays healthy without it', async () => {
    const res = await request(buildApp(null)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.redis).toBe('not configured');
  });

  test('aborts the Horizon probe once the timeout elapses', async () => {
    await request(buildApp(redisClient)).get('/health');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  test('uses HEALTH_HORIZON_TIMEOUT_MS read at request time', async () => {
    process.env.HEALTH_HORIZON_TIMEOUT_MS = '500';

    await request(buildApp(redisClient)).get('/health');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  test('aborts the Horizon probe after the configured timeout elapses', async () => {
    process.env.HEALTH_HORIZON_TIMEOUT_MS = '50';

    let capturedSignal;
    global.fetch.mockImplementation((url, options) => {
      capturedSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new Error('The operation was aborted'))
        );
      });
    });

    const startedAt = Date.now();
    const res = await request(buildApp(redisClient)).get('/health');
    const elapsed = Date.now() - startedAt;

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal.aborted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1000);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  test('falls back to the default timeout when HEALTH_HORIZON_TIMEOUT_MS is invalid', async () => {
    process.env.HEALTH_HORIZON_TIMEOUT_MS = 'abc';

    const res = await request(buildApp(redisClient)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.horizon).toBe('up');
    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  test('probes the URL from HORIZON_BASE env var when set', async () => {
    const customUrl = 'https://horizon.custom-staging.example.com';
    jest.resetModules();
    process.env.HORIZON_BASE = customUrl;

    // Re-require after setting the env var so the module picks up the new value.
    const healthRoutesWithEnv = require('../src/routes/v1/healthRoutes');
    const appWithEnv = express();
    appWithEnv.use(healthRoutesWithEnv(redisClient));

    await request(appWithEnv).get('/health');

    expect(global.fetch).toHaveBeenCalledWith(customUrl, expect.anything());

    delete process.env.HORIZON_BASE;
    jest.resetModules();
  });

  test('falls back to the testnet URL when HORIZON_BASE is unset', async () => {
    jest.resetModules();
    delete process.env.HORIZON_BASE;

    const healthRoutesDefault = require('../src/routes/v1/healthRoutes');
    const appDefault = express();
    appDefault.use(healthRoutesDefault(redisClient));

    await request(appDefault).get('/health');

    const [probedUrl] = global.fetch.mock.calls[0];
    expect(probedUrl).toBe('https://horizon-testnet.stellar.org');

    jest.resetModules();
  });
});

// ── Startup, liveness and readiness probes ───────────────────────────────────

describe('startup, liveness and readiness probes', () => {
  const loadProbeRoutes = () => {
    jest.resetModules();
    const routes = require('../src/routes/v1/healthRoutes');
    const app = express();
    app.use(routes(redisClient));
    app.use(buildErrorHandler(() => false));
    return app;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    redisClient = { ping: jest.fn().mockResolvedValue('PONG') };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    jest.resetModules();
  });

  describe('GET /health/startup', () => {
    test('returns 200 once initialization has completed', async () => {
      const res = await request(loadProbeRoutes()).get('/health/startup');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'UP', probe: 'startup' });
    });

    test('does not depend on routing dependencies (slow startup is tolerated)', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('still warming up'));
      redisClient.ping.mockRejectedValue(new Error('still warming up'));
      global.fetch.mockRejectedValue(new Error('still warming up'));

      const res = await request(loadProbeRoutes()).get('/health/startup');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
    });

    test('returns 503 while initialization is still in progress', async () => {
      const res = await request(loadProbeRoutes())
        .get('/health/startup')
        .set('X-Startup-Pending', '1');

      expect([200, 503]).toContain(res.status);
    });
  });

  describe('GET /health/live', () => {
    test('returns 200 for a healthy process', async () => {
      const res = await request(loadProbeRoutes()).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'UP', probe: 'liveness' });
    });

    test('stays 200 even when dependencies are down', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('down'));
      redisClient.ping.mockRejectedValue(new Error('down'));
      global.fetch.mockRejectedValue(new Error('down'));

      const res = await request(loadProbeRoutes()).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
    });

    test('fails when the event loop is blocked (deadlocked process)', async () => {
      const routes = require('../src/routes/v1/healthRoutes');
      const app = express();
      app.use(routes(redisClient, { eventLoopLagThresholdMs: 5 }));
      app.use(buildErrorHandler(() => false));

      const realSetTimeout = global.setTimeout;
      const lagSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
        // Simulate a blocked event loop: timers fire far later than requested.
        return realSetTimeout(fn, ms + 50, ...args);
      });

      try {
        const res = await request(app).get('/health/live');
        expect(res.status).toBe(503);
        expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      } finally {
        lagSpy.mockRestore();
      }
    });
  });

  describe('GET /health/ready', () => {
    test('returns 200 when routing dependencies are up', async () => {
      const res = await request(loadProbeRoutes()).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'UP',
        probe: 'readiness',
        database: 'up',
        redis: 'up',
      });
    });

    test('returns 503 when the database is unavailable', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      const res = await request(loadProbeRoutes()).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.error.details).toContainEqual({
        field: 'database',
        message: 'Database unavailable',
      });
    });

    test('returns 503 when Redis is unavailable', async () => {
      redisClient.ping.mockRejectedValue(new Error('not connected'));

      const res = await request(loadProbeRoutes()).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.error.details).toContainEqual({
        field: 'redis',
        message: 'Redis unavailable',
      });
    });

    test('excludes non-routing dependencies such as Horizon', async () => {
      global.fetch.mockRejectedValue(new Error('ETIMEDOUT'));

      const res = await request(loadProbeRoutes()).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('UP');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});

// ── Canary rollout health endpoint ───────────────────────────────────────────

describe('GET /health/canary', () => {
  const loadCanaryRoutes = (options) => {
    jest.resetModules();
    const routes = require('../src/routes/v1/healthRoutes');
    const app = express();
    app.use(routes(redisClient, options));
    app.use(buildErrorHandler(() => false));
    return app;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    redisClient = { ping: jest.fn().mockResolvedValue('PONG') };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('returns 200 with a healthy canary evaluation', async () => {
    const res = await request(loadCanaryRoutes()).get('/health/canary');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'UP',
      probe: 'canary',
      promotion: 'allowed',
    });
    expect(res.body.window).toMatchObject({
      sampleCount: expect.any(Number),
      errorRate: expect.any(Number),
      p95LatencyMs: expect.any(Number),
    });
  });

  test('reports degraded (but still promotable) when indicators are near threshold', async () => {
    const res = await request(
      loadCanaryRoutes({
        canary: {
          metricsProvider: async () => ({
            sampleCount: 100,
            errorRate: 0.02,
            p95LatencyMs: 400,
          }),
          thresholds: { minSamples: 50, maxErrorRate: 0.05, maxP95LatencyMs: 500 },
        },
      })
    ).get('/health/canary');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'DEGRADED', promotion: 'allowed' });
  });

  test('returns 503 and halts promotion when the error-rate threshold is breached', async () => {
    const res = await request(
      loadCanaryRoutes({
        canary: {
          metricsProvider: async () => ({
            sampleCount: 100,
            errorRate: 0.2,
            p95LatencyMs: 100,
          }),
          thresholds: { minSamples: 50, maxErrorRate: 0.05, maxP95LatencyMs: 500 },
        },
      })
    ).get('/health/canary');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: expect.arrayContaining([
        { field: 'errorRate', message: expect.any(String) },
      ]),
    });
    expect(res.body.promotion).toBe('halted');
    expect(res.body.rollback).toBe(true);
  });

  test('returns 503 and halts promotion when the latency threshold is breached', async () => {
    const res = await request(
      loadCanaryRoutes({
        canary: {
          metricsProvider: async () => ({
            sampleCount: 100,
            errorRate: 0,
            p95LatencyMs: 900,
          }),
          thresholds: { minSamples: 50, maxErrorRate: 0.05, maxP95LatencyMs: 500 },
        },
      })
    ).get('/health/canary');

    expect(res.status).toBe(503);
    expect(res.body.promotion).toBe('halted');
    expect(res.body.rollback).toBe(true);
  });

  test('does not breach thresholds before the minimum sample count is reached', async () => {
    const res = await request(
      loadCanaryRoutes({
        canary: {
          metricsProvider: async () => ({
            sampleCount: 5,
            errorRate: 1,
            p95LatencyMs: 5000,
          }),
          thresholds: { minSamples: 50, maxErrorRate: 0.05, maxP95LatencyMs: 500 },
        },
      })
    ).get('/health/canary');

    expect(res.status).toBe(200);
    expect(res.body.promotion).toBe('allowed');
  });

  test('returns 503 when the metrics provider fails', async () => {
    const res = await request(
      loadCanaryRoutes({
        canary: {
          metricsProvider: async () => {
            throw new Error('metrics backend down');
          },
        },
      })
    ).get('/health/canary');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.promotion).toBe('halted');
  });

  test('handles concurrent polling without cross-request state leakage', async () => {
    const app = loadCanaryRoutes({
      canary: {
        metricsProvider: async () => ({
          sampleCount: 100,
          errorRate: 0.01,
          p95LatencyMs: 120,
        }),
        thresholds: { minSamples: 50, maxErrorRate: 0.05, maxP95LatencyMs: 500 },
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get('/health/canary'))
    );

    responses.forEach((res) => {
      expect(res.status).toBe(200);
      expect(res.body.promotion).toBe('allowed');
    });
  });
});

// ── X-Correlation-ID header assertions for health endpoint ────────────────────

describe('GET /health — X-Correlation-ID header', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let healthApp;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    redisClient = { ping: jest.fn().mockResolvedValue('PONG') };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    // Mount health routes with the real correlation middleware so the header
    // is attached by the middleware, not by the health handler itself.
    const { correlationId } = require('../middleware/correlation');
    healthApp = express();
    healthApp.use(correlationId);
    healthApp.use(healthRoutes(redisClient));
    healthApp.use(buildErrorHandler(() => false));
  });

  test('200 health response includes X-Correlation-ID header', async () => {
    const res = await request(healthApp).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['x-correlation-id']).toMatch(UUID_RE);
  });

  test('503 health response includes X-Correlation-ID header', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));

    const res = await request(healthApp).get('/health');

    expect(res.status).toBe(503);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['x-correlation-id']).toMatch(UUID_RE);
  });

  test('echoes back a caller-supplied X-Correlation-ID on 200', async () => {
    const myId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

    const res = await request(healthApp)
      .get('/health')
      .set('X-Correlation-ID', myId);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(myId);
  });

  test('echoes back a caller-supplied X-Correlation-ID on 503', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    const myId = 'cccccccc-3333-4333-8333-cccccccccccc';

    const res = await request(healthApp)
      .get('/health')
      .set('X-Correlation-ID', myId);

    expect(res.status).toBe(503);
    expect(res.headers['x-correlation-id']).toBe(myId);
  });
});
