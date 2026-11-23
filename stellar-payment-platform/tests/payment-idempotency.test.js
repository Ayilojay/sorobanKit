'use strict';

const express = require('express');
const request = require('supertest');

const mockPaymentIntentCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    paymentIntent: { create: mockPaymentIntentCreate },
    $transaction: mockTransaction,
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');
const buildPaymentRouter = require('../src/routes/v1/paymentRoutes');
const buildPaymentStreamRouter = require('../src/routes/v1/paymentStreamRoutes');

const baseIntent = {
  external_id: 'order-123',
  from: 'GSOURCE',
  to: 'GDESTINATION',
  amount: '25.00',
};

describe('payment intent creation idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentIntentCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'intent-1', externalId: data.externalId, metadata: data.metadata }),
    );
    mockTransaction.mockImplementation((operations) => Promise.all(operations));
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/', buildPaymentRouter(null));
    return app;
  };

  test('deduplicates identical bulk payment submissions', async () => {
    const app = buildApp();

    const payload = [{ ...baseIntent }];
    const first = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-key-1')
      .send(payload);
    const second = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-key-1')
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  test('distinct keys create separate intents', async () => {
    const app = buildApp();

    await request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'pay-a').send([baseIntent]);
    await request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'pay-b').send([baseIntent]);

    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(2);
  });
});

describe('bulk payment intent creation atomicity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPaymentIntentCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: `intent-${data.externalId}`, externalId: data.externalId, metadata: data.metadata }),
    );
    mockTransaction.mockImplementation((operations) => Promise.all(operations));
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/', buildPaymentRouter(null));
    return app;
  };

  test('creates all items atomically and preserves ordering', async () => {
    const app = buildApp();
    const payload = [
      { ...baseIntent, external_id: 'order-a' },
      { ...baseIntent, external_id: 'order-b' },
      { ...baseIntent, external_id: 'order-c' },
    ];

    const res = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'bulk-atomic-1')
      .send(payload);

    expect(res.status).toBe(201);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(3);
    const createdOrder = mockPaymentIntentCreate.mock.calls.map(([args]) => args.data.externalId);
    expect(createdOrder).toEqual(['order-a', 'order-b', 'order-c']);
    expect(res.body.items.map((item) => item.externalId)).toEqual(['order-a', 'order-b', 'order-c']);
  });

  test('rejects the whole batch when any item fails validation', async () => {
    const app = buildApp();
    const payload = [
      { ...baseIntent, external_id: 'order-ok' },
      { ...baseIntent, external_id: 'order-bad', amount: '-5.00' },
    ];

    const res = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'bulk-invalid-1')
      .send(payload);

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1 })]),
    );
  });

  test('rejects duplicate external IDs within a batch', async () => {
    const app = buildApp();
    const payload = [
      { ...baseIntent, external_id: 'order-dup' },
      { ...baseIntent, external_id: 'order-dup' },
    ];

    const res = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'bulk-dup-1')
      .send(payload);

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1, code: 'DUPLICATE_EXTERNAL_ID' })]),
    );
  });

  test('rolls back all items when persistence fails mid-batch', async () => {
    mockTransaction.mockImplementation(() => Promise.reject(new Error('db failure')));
    const app = buildApp();

    const res = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'bulk-fail-1')
      .send([{ ...baseIntent, external_id: 'order-x' }, { ...baseIntent, external_id: 'order-y' }]);

    expect(res.status).toBe(500);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  test('concurrent retries with the same key persist the batch once', async () => {
    const app = buildApp();
    const payload = [{ ...baseIntent, external_id: 'order-concurrent' }];

    const [first, second] = await Promise.all([
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'bulk-concurrent-1').send(payload),
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'bulk-concurrent-1').send(payload),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
  });
});

describe('payment status SSE stream', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const buildStreamApp = (options = {}) => {
    const app = express();
    app.use(express.json());
    app.use('/', buildPaymentStreamRouter(options));
    return app;
  };

  const openStream = (app, path = '/payments/stream', headers = {}) =>
    request(app).get(path).set('Accept', 'text/event-stream').set(headers).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', cb);
    });

  test('rejects unauthenticated subscribers', async () => {
    const app = buildStreamApp();
    const res = await request(app).get('/payments/stream').set('Accept', 'text/event-stream');
    expect(res.status).toBe(401);
  });

  test('rejects subscribers without the required scope', async () => {
    const app = buildStreamApp({
      authorize: () => ({ ok: false, status: 403, reason: 'missing scope' }),
    });
    const res = await request(app).get('/payments/stream').set('Accept', 'text/event-stream');
    expect(res.status).toBe(403);
  });

  test('emits versioned events with ids and resumes from a cursor', async () => {
    const app = buildStreamApp();
    const res = await openStream(app, '/payments/stream?cursor=0');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: payment.status');
    expect(res.text).toMatch(/id: \d+/);
    expect(res.text).toMatch(/version: 1/);
  });

  test('sends heartbeat comments to keep connections alive', async () => {
    const app = buildStreamApp({ heartbeatIntervalMs: 5, maxEvents: 1 });
    const res = await openStream(app);
    await flush();
    expect(res.text).toContain(': heartbeat');
  });

  test('enforces the per-client connection limit', async () => {
    const app = buildStreamApp({ maxConnectionsPerClient: 1, maxEvents: 1 });
    const first = await openStream(app, '/payments/stream', { 'X-Client-Id': 'client-1' });
    expect(first.status).toBe(200);
    const second = await request(app)
      .get('/payments/stream')
      .set('Accept', 'text/event-stream')
      .set('X-Client-Id', 'client-1');
    expect(second.status).toBe(429);
  });

  test('cleans up subscriber state on disconnect', async () => {
    const cleanup = jest.fn();
    const app = buildStreamApp({ maxEvents: 1, onDisconnect: cleanup });
    await openStream(app);
    await flush();
    expect(cleanup).toHaveBeenCalled();
  });
});
