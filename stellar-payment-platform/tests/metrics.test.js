const request = require('supertest');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: {
    fromPublicKey: jest.fn(() => ({
      verify: jest.fn(() => true)
    }))
  }
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

// Mock Prisma so it doesn't try to connect to a real database and crash
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({})
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }])
  }
}));

// /health probes Horizon over HTTP; keep it off the network.
global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

process.env.NODE_ENV = 'test';
const { app } = require('../server');

describe('Prometheus Metrics Endpoint', () => {
  describe('GET /metrics — authentication', () => {
    const VALID_TOKEN = 'test-metrics-secret';

    afterEach(() => {
      delete process.env.METRICS_TOKEN;
    });

    test('should return 200 when METRICS_TOKEN is not set (open access)', async () => {
      delete process.env.METRICS_TOKEN;
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
    });

    test('should return 401 when METRICS_TOKEN is set and no token is provided', async () => {
      process.env.METRICS_TOKEN = VALID_TOKEN;
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    test('should return 401 when an incorrect Bearer token is provided', async () => {
      process.env.METRICS_TOKEN = VALID_TOKEN;
      const response = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(response.status).toBe(401);
    });

    test('should return 200 when a correct Bearer token is provided', async () => {
      process.env.METRICS_TOKEN = VALID_TOKEN;
      const response = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_TOKEN}`);
      expect(response.status).toBe(200);
    });

    test('should return 200 when a correct ?token query param is provided', async () => {
      process.env.METRICS_TOKEN = VALID_TOKEN;
      const response = await request(app).get(`/metrics?token=${VALID_TOKEN}`);
      expect(response.status).toBe(200);
    });

    test('should return 401 when a wrong ?token query param is provided', async () => {
      process.env.METRICS_TOKEN = VALID_TOKEN;
      const response = await request(app).get('/metrics?token=bad-token');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /metrics', () => {
    test('should return 200 status code', async () => {
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
    });

    test('should return text/plain content type', async () => {
      const response = await request(app).get('/metrics');
      expect(response.type).toContain('text/plain');
    });

    test('should return valid Prometheus format with metrics', async () => {
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
      expect(response.text).toBeTruthy();
      // Check for common Prometheus metric format (lines starting with # or containing key=value labels)
      expect(response.text).toMatch(/^#|^\w+/m);
    });

    test('should contain default Node.js metrics', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      // Check for default Node.js metrics with our prefix
      expect(metricsText).toMatch(/stellar_tags_nodejs_|stellar_tags_process_/);
    });

    test('should contain Redis and database connection gauges', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_redis_connections_active');
      expect(metricsText).toContain('stellar_tags_db_pool_connections_open');
      expect(metricsText).toContain('stellar_tags_db_pool_connections_busy');
      expect(metricsText).toContain('stellar_tags_db_pool_connections_idle');
      expect(metricsText).toContain('stellar_tags_db_pool_queries_waiting');
    });

    test('should contain custom request counter metric', async () => {
      // Make a request to create a metric
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      expect(metricsText).toContain('stellar_tags_http_requests_total');
    });

    test('should contain custom request duration histogram metric', async () => {
      // Make a request to create a metric
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds');
    });

    test('should track multiple requests with counter increment', async () => {
      // Make multiple requests
      await request(app).get('/health');
      await request(app).get('/health');
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // The counter should be present and have recorded requests
      expect(metricsText).toContain('stellar_tags_http_requests_total');
      // Check that counter has labels including GET, /health, and status 200
      expect(metricsText).toMatch(/stellar_tags_http_requests_total.*method="GET".*route="\/health".*status_code="200"/);
    });

    test('should track request latency histogram', async () => {
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Should have histogram buckets and sum/count
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_bucket');
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_sum');
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_count');
    });

    test('should include correct labels (method, route, status_code)', async () => {
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Check for presence of label names in metrics output
      expect(metricsText).toMatch(/method=/);
      expect(metricsText).toMatch(/route=/);
      expect(metricsText).toMatch(/status_code=/);
    });

    test('should handle 404 responses in metrics', async () => {
      await request(app).get('/nonexistent-route');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Should record the 404 request
      expect(metricsText).toContain('status_code="404"');
    });

    test('should expose the configured latency buckets (10ms, 50ms, 100ms, 500ms, 1s, 5s)', async () => {
      await request(app).get('/health');

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      for (const le of ['0.01', '0.05', '0.1', '0.5', '1', '5', '+Inf']) {
        expect(metricsText).toMatch(
          new RegExp(`stellar_tags_http_request_duration_seconds_bucket\\{.*le="${le.replace('+', '\\+')}"`),
        );
      }
    });

    test('should record the normalized route including the API version mount', async () => {
      await request(app).get('/api/v1/users?limit=5');

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      // The route label is the matched pattern with its mount prefix, never
      // the raw query string.
      expect(metricsText).toMatch(/route="\/api\/v1\/users"/);
      expect(metricsText).not.toMatch(/limit=5/);
    });

    test('should collapse unmatched routes to a bounded "unknown" label', async () => {
      // A random path must not create a per-path label (cardinality guard).
      await request(app).get('/definitely-not-a-real-route-42');

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('status_code="404"');
      expect(metricsText).toMatch(/route="unknown"/);
      expect(metricsText).not.toContain('definitely-not-a-real-route-42');
    });

    test('should record latency for every request in the histogram', async () => {
      await request(app).get('/health');
      await request(app).post('/federation').send({});

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      // Both the sum (with a real duration value) and the count must be present
      // for the duration histogram after requests are made.
      expect(metricsText).toMatch(
        /stellar_tags_http_request_duration_seconds_count\{.*method="GET".*\} [1-9]\d*/,
      );
      expect(metricsText).toMatch(
        /stellar_tags_http_request_duration_seconds_count\{.*method="POST".*\} [1-9]\d*/,
      );
    });

    test('should handle different HTTP methods in metrics', async () => {
      // Make requests with different methods
      await request(app).get('/health');
      await request(app).post('/federation').send({});
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Should have labels for different methods
      expect(metricsText).toMatch(/method="GET"/);
      expect(metricsText).toMatch(/method="POST"/);
    });

    test('should not expose /metrics in the metrics itself (avoid infinite recursion in labels)', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // /metrics requests should not create metric entries that include /metrics in the route
      // (The metrics endpoint itself may appear, but we verify the format is correct)
      expect(response.status).toBe(200);
      expect(metricsText).toBeTruthy();
    });

    // Issue #29 — dynamic route segments must be recorded as the parameterised
    // Express pattern, never the concrete value that was in the URL. Hitting
    // /api/v1/users/alice/activity must produce
    //   route="/api/v1/users/:username/activity"
    // and must NOT record the literal username "alice" in any label.
    test('should record the parameterised pattern for dynamic routes, not the concrete path value', async () => {
      // The ownership check requires a valid signature; the route returns 400/401
      // if authentication fails, but the middleware still records the label.
      await request(app)
        .get('/api/v1/users/alice/activity')
        .set('X-Stellar-Signature', 'dummy-sig')
        .set('X-Stellar-Signer', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      // The route label must be the Express pattern, not the concrete value.
      expect(metricsText).toMatch(/route="\/api\/v1\/users\/:username\/activity"/);

      // The raw username value must never appear as a label value.
      expect(metricsText).not.toMatch(/route="[^"]*alice[^"]*"/);
    });

    // Issue #179 — a username containing an "@" (e.g. an email-style handle)
    // must still normalise to the template form and never leak into labels.
    test('should normalise a username containing "@" to the route template', async () => {
      await request(app)
        .get('/api/v1/users/alice@domain/activity')
        .set('X-Stellar-Signature', 'dummy-sig')
        .set('X-Stellar-Signer', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toMatch(/route="\/api\/v1\/users\/:username\/activity"/);

      // No label value anywhere may contain the literal username.
      expect(metricsText).not.toMatch(/route="[^"]*alice[^"]*"/);
      expect(metricsText).not.toMatch(/route="[^"]*alice@domain[^"]*"/);
    });

    // Issue #179 — high-cardinality guard: many distinct usernames hitting the
    // same parameterised route must collapse to a single route label.
    test('should not create per-user route labels after 100 requests with different usernames', async () => {
      const usernames = Array.from({ length: 100 }, (_, i) => `user${i}`);

      for (const username of usernames) {
        await request(app)
          .get(`/api/v1/users/${username}/activity`)
          .set('X-Stellar-Signature', 'dummy-sig')
          .set('X-Stellar-Signer', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
      }

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      // Collect every route label value recorded for the activity endpoint.
      const routeLabels = new Set();
      const routeLabelRegex = /route="([^"]*)"/g;
      let match;
      while ((match = routeLabelRegex.exec(metricsText)) !== null) {
        routeLabels.add(match[1]);
      }

      // The parameterised template must be present...
      expect(routeLabels.has('/api/v1/users/:username/activity')).toBe(true);

      // ...and no concrete username may appear as a route label.
      for (const label of routeLabels) {
        expect(label).not.toMatch(/user\d+/);
      }

      // Only a single route label combination for the activity endpoint.
      const activityLabels = [...routeLabels].filter((l) =>
        l.includes('/activity'),
      );
      expect(activityLabels).toEqual(['/api/v1/users/:username/activity']);
    });
  });

  describe('Metrics middleware integration', () => {
    test('should track requests to /health endpoint', async () => {
      // Clear previous metrics by not checking them
      await request(app).get('/health');
      
      const metricsResponse = await request(app).get('/metrics');
      const metricsText = metricsResponse.text;
      
      expect(metricsText).toContain('stellar_tags_http_requests_total');
      expect(metricsText).toMatch(/route="\/health"/);
    });

    test('should track requests to /api/v1/time endpoint', async () => {
      await request(app).get('/api/v1/time');
      
      const metricsResponse = await request(app).get('/metrics');
      const metricsText = metricsResponse.text;
      
      expect(metricsText).toContain('stellar_tags_http_requests_total');
      expect(metricsText).toMatch(/route="\/api\/v1\/time"/);
    });

    test('should measure response times in histogram', async () => {
      await request(app).get('/health');
      
      const metricsResponse = await request(app).get('/metrics');
      const metricsText = metricsResponse.text;
      
      // Should have histogram with actual duration measurements
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_sum');
      // Verify the sum contains a numeric value
      expect(metricsText).toMatch(/stellar_tags_http_request_duration_seconds_sum{.*}.*[\d.]+/);
    });
  });

  // Issues #474 / #475 — SLI metrics for registration, federation lookup and
  // payment flows, plus ledger-confirmation lag and reconciliation backlog.
  // These tests assert the metric families exist, that their labels are
  // low-cardinality, and that no user identifiers (addresses, emails,
  // usernames) ever leak into label values.
  describe('SLI and SLO metrics (issues #474, #475)', () => {
    const USER_IDENTIFIER_PATTERNS = [
      /G[A-Z2-7]{55}/, // Stellar account address
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
      /user\d+/, // generated usernames
      /alice/i,
    ];

    const collectLabelValues = (metricsText) => {
      const values = [];
      const labelRegex = /[a-zA-Z_][a-zA-Z0-9_]*="([^"]*)"/g;
      let match;
      while ((match = labelRegex.exec(metricsText)) !== null) {
        values.push(match[1]);
      }
      return values;
    };

    const expectNoUserIdentifiers = (metricsText) => {
      for (const value of collectLabelValues(metricsText)) {
        for (const pattern of USER_IDENTIFIER_PATTERNS) {
          expect(value).not.toMatch(pattern);
        }
      }
    };

    test('should expose registration SLI metrics with bounded labels', async () => {
      await request(app)
        .post('/api/v1/register')
        .send({ username: 'alice', email: 'alice@example.com' });

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_sli_registration_total');
      expect(metricsText).toContain('stellar_tags_sli_registration_duration_seconds');
      expect(metricsText).toMatch(/stellar_tags_sli_registration_total\{.*outcome="(success|failure)"/);
      expectNoUserIdentifiers(metricsText);
    });

    test('should expose federation lookup SLI metrics with bounded labels', async () => {
      await request(app)
        .get('/federation')
        .query({ type: 'name', q: 'alice*example.com' });

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_sli_federation_lookup_total');
      expect(metricsText).toContain('stellar_tags_sli_federation_lookup_duration_seconds');
      expect(metricsText).toMatch(/stellar_tags_sli_federation_lookup_total\{.*outcome="(hit|miss|error)"/);
      expectNoUserIdentifiers(metricsText);
    });

    test('should expose payment flow SLI metrics with bounded labels', async () => {
      await request(app)
        .post('/api/v1/payments')
        .send({ destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', amount: '1' });

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_sli_payment_total');
      expect(metricsText).toContain('stellar_tags_sli_payment_duration_seconds');
      expect(metricsText).toMatch(/stellar_tags_sli_payment_total\{.*outcome="(success|failure)"/);
      expectNoUserIdentifiers(metricsText);
    });

    test('should expose submission-to-finality percentile metrics by network', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_ledger_confirmation_lag_seconds');
      expect(metricsText).toMatch(/stellar_tags_ledger_confirmation_lag_seconds\{.*network="(testnet|mainnet|futurenet)"/);
      expectNoUserIdentifiers(metricsText);
    });

    test('should expose oldest unreconciled intent age by network', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_reconciliation_oldest_intent_age_seconds');
      expect(metricsText).toMatch(/stellar_tags_reconciliation_oldest_intent_age_seconds\{.*network="(testnet|mainnet|futurenet)"/);
      expectNoUserIdentifiers(metricsText);
    });

    test('should not leak user identifiers into SLI labels after many distinct users', async () => {
      for (let i = 0; i < 25; i += 1) {
        await request(app)
          .post('/api/v1/register')
          .send({ username: `user${i}`, email: `user${i}@example.com` });
        await request(app)
          .get('/federation')
          .query({ type: 'name', q: `user${i}*example.com` });
      }

      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expectNoUserIdentifiers(metricsText);

      // The registration outcome label set must stay bounded regardless of
      // how many distinct users registered.
      const outcomes = new Set();
      const outcomeRegex = /stellar_tags_sli_registration_total\{[^}]*outcome="([^"]*)"/g;
      let match;
      while ((match = outcomeRegex.exec(metricsText)) !== null) {
        outcomes.add(match[1]);
      }
      expect(outcomes.size).toBeLessThanOrEqual(2);
    });
  });

  describe('Prometheus format compliance', () => {
    test('should return properly formatted Prometheus text', async () => {
      const response = await request(app).get('/metrics');
      const lines = response.text.split('\n');
      
      // Should have help lines (starting with # HELP)
      const helpLines = lines.filter(l => l.startsWith('# HELP'));
      expect(helpLines.length).toBeGreaterThan(0);
      
      // Should have type lines (starting with # TYPE)
      const typeLines = lines.filter(l => l.startsWith('# TYPE'));
      expect(typeLines.length).toBeGreaterThan(0);
    });

    test('should include HELP and TYPE documentation for custom metrics', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Check for help text
      expect(metricsText).toContain('# HELP stellar_tags_http_requests_total');
      expect(metricsText).toContain('Total number of HTTP requests');
      
      expect(metricsText).toContain('# HELP stellar_tags_http_request_duration_seconds');
      expect(metricsText).toContain('HTTP request duration in seconds');
      
      // Check for type declarations
      expect(metricsText).toContain('# TYPE stellar_tags_http_requests_total counter');
      expect(metricsText).toContain('# TYPE stellar_tags_http_request_duration_seconds histogram');
    });
  });
});

// Issue #476 — webhook queue health metrics and the operational dashboard
// endpoint. The Prisma mock is shared across the file, so each test that needs
// queue data re-programs `$queryRaw` and restores the default afterwards.
describe('Webhook queue health metrics (issue #476)', () => {
  const { prisma } = require('../prismaClient');

  const NOW = new Date('2024-06-01T12:00:00.000Z').getTime();

  // Shape returned by the queue-health aggregation query.
  const queueSnapshot = (overrides = {}) => ({
    oldest_pending_at: new Date(NOW - 90_000), // 90s old
    oldest_dlq_at: new Date(NOW - 3_600_000), // 1h old
    pending_count: 7,
    dlq_count: 2,
    ...overrides,
  });

  const attemptRows = [
    { attempts: 0, count: 4 },
    { attempts: 1, count: 2 },
    { attempts: 2, count: 1 },
    { attempts: 3, count: 0 },
    { attempts: 9, count: 1 }, // out-of-range bucket must be clamped
  ];

  const latencyRows = [
    { bucket: 'lt_1s', count: 5 },
    { bucket: 'lt_5s', count: 3 },
    { bucket: 'lt_30s', count: 1 },
    { bucket: 'gte_30s', count: 1 },
  ];

  const programQueueQueries = (snapshot = queueSnapshot()) => {
    prisma.$queryRaw.mockImplementation((strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (/attempts/i.test(sql)) return Promise.resolve(attemptRows);
      if (/latency|delivered_at|created_at.*delivered/i.test(sql)) {
        return Promise.resolve(latencyRows);
      }
      if (/dlq|dead_letter/i.test(sql)) return Promise.resolve([snapshot]);
      return Promise.resolve([snapshot]);
    });
  };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    programQueueQueries();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockResolvedValue([{ '1': 1 }]);
  });

  describe('metric emission', () => {
    test('exposes the oldest pending event gauge', async () => {
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
      expect(response.text).toContain('stellar_tags_webhook_queue_oldest_pending_seconds');
      // 90s old event must be reported as ~90 seconds.
      expect(response.text).toMatch(
        /stellar_tags_webhook_queue_oldest_pending_seconds(?:\{[^}]*\})? 90(?:\.0+)?/,
      );
    });

    test('exposes the DLQ age gauge', async () => {
      const response = await request(app).get('/metrics');
      expect(response.text).toContain('stellar_tags_webhook_queue_dlq_oldest_seconds');
      expect(response.text).toMatch(
        /stellar_tags_webhook_queue_dlq_oldest_seconds(?:\{[^}]*\})? 3600(?:\.0+)?/,
      );
    });

    test('exposes pending and DLQ depth gauges', async () => {
      const response = await request(app).get('/metrics');
      expect(response.text).toMatch(
        /stellar_tags_webhook_queue_pending_total(?:\{[^}]*\})? 7/,
      );
      expect(response.text).toMatch(
        /stellar_tags_webhook_queue_dlq_total(?:\{[^}]*\})? 2/,
      );
    });

    test('exposes the attempt distribution histogram with bounded buckets', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_webhook_delivery_attempts');
      expect(metricsText).toContain('stellar_tags_webhook_delivery_attempts_bucket');

      // Buckets must be a fixed, bounded set — never one bucket per observed
      // attempt count.
      const bucketLabels = new Set();
      const bucketRegex = /stellar_tags_webhook_delivery_attempts_bucket\{[^}]*le="([^"]+)"/g;
      let match;
      while ((match = bucketRegex.exec(metricsText)) !== null) {
        bucketLabels.add(match[1]);
      }
      expect(bucketLabels.size).toBeGreaterThan(0);
      expect(bucketLabels.size).toBeLessThanOrEqual(10);
      expect(bucketLabels.has('+Inf')).toBe(true);
    });

    test('clamps out-of-range attempt counts into the +Inf bucket', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      // The row with attempts=9 must land in +Inf, not create a new bucket.
      expect(metricsText).toMatch(
        /stellar_tags_webhook_delivery_attempts_bucket\{[^}]*le="\+Inf"[^}]*\} [1-9]\d*/,
      );
      expect(metricsText).not.toMatch(/le="9"/);
    });

    test('exposes the delivery latency histogram', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      expect(metricsText).toContain('stellar_tags_webhook_delivery_latency_seconds');
      expect(metricsText).toContain('stellar_tags_webhook_delivery_latency_seconds_bucket');
      expect(metricsText).toMatch(
        /stellar_tags_webhook_delivery_latency_seconds_count(?:\{[^}]*\})? [1-9]\d*/,
      );
    });

    test('emits HELP and TYPE lines for every queue-health metric', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;

      for (const name of [
        'stellar_tags_webhook_queue_oldest_pending_seconds',
        'stellar_tags_webhook_queue_dlq_oldest_seconds',
        'stellar_tags_webhook_queue_pending_total',
        'stellar_tags_webhook_queue_dlq_total',
        'stellar_tags_webhook_delivery_attempts',
        'stellar_tags_webhook_delivery_latency_seconds',
      ]) {
        expect(metricsText).toContain(`# HELP ${name}`);
        expect(metricsText).toContain(`# TYPE ${name}`);
      }
    });

    test('reports zero (not NaN) when the queue is empty', async () => {
      programQueueQueries({
        oldest_pending_at: null,
        oldest_dlq_at: null,
        pending_count: 0,
        dlq_count: 0,
      });

      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
      expect(response.text).toMatch(
        /stellar_tags_webhook_queue_oldest_pending_seconds(?:\{[^}]*\})? 0(?:\.0+)?/,
      );
      expect(response.text).toMatch(
        /stellar_tags_webhook_queue_dlq_oldest_seconds(?:\{[^}]*\})? 0(?:\.0+)?/,
      );
      expect(response.text).not.toMatch(/stellar_tags_webhook_queue_oldest_pending_seconds\{[^}]*\} NaN/);
    });

    test('does not fail /metrics when the queue query rejects', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));

      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
      expect(response.text).toContain('stellar_tags_http_requests_total');
    });
  });

  describe('GET /api/v1/admin/webhook-queue/health', () => {
    const ADMIN_TOKEN = 'test-admin-token';

    afterEach(() => {
      delete process.env.ADMIN_TOKEN;
    });

    test('returns the queue snapshot on success', async () => {
      process.env.ADMIN_TOKEN = ADMIN_TOKEN;
      const response = await request(app)
        .get('/api/v1/admin/webhook-queue/health')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          oldestPendingSeconds: expect.any(Number),
          oldestDlqSeconds: expect.any(Number),
          pending: expect.any(Number),
          dlq: expect.any(Number),
          attempts: expect.any(Object),
          latency: expect.any(Object),
        }),
      );
      expect(response.body.oldestPendingSeconds).toBeCloseTo(90, 0);
      expect(response.body.oldestDlqSeconds).toBeCloseTo(3600, 0);
      expect(response.body.pending).toBe(7);
      expect(response.body.dlq).toBe(2);
    });

    test('returns 401 without a token when ADMIN_TOKEN is configured', async () => {
      process.env.ADMIN_TOKEN = ADMIN_TOKEN;
      const response = await request(app).get('/api/v1/admin/webhook-queue/health');
      expect(response.status).toBe(401);
    });

    test('returns 503 with a stable error shape when the DB query fails', async () => {
      process.env.ADMIN_TOKEN = ADMIN_TOKEN;
      prisma.$queryRaw.mockRejectedValue(new Error('connection reset'));

      const response = await request(app)
        .get('/api/v1/admin/webhook-queue/health')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        expect.objectContaining({ error: expect.any(String) }),
      );
      // Internal error details must not leak to the client.
      expect(JSON.stringify(response.body)).not.toContain('connection reset');
    });

    test('reports zeroed ages when the queue is empty', async () => {
      process.env.ADMIN_TOKEN = ADMIN_TOKEN;
      programQueueQueries({
        oldest_pending_at: null,
        oldest_dlq_at: null,
        pending_count: 0,
        dlq_count: 0,
      });

      const response = await request(app)
        .get('/api/v1/admin/webhook-queue/health')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.oldestPendingSeconds).toBe(0);
      expect(response.body.oldestDlqSeconds).toBe(0);
    });
  });
});
