'use strict';

const express = require('express');
const request = require('supertest');

const mockPaymentIntentCreate = jest.fn();
const mockTransaction = jest.fn();
const mockIdempotencyFindUnique = jest.fn();
const mockIdempotencyCreate = jest.fn();
const mockIdempotencyDelete = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    paymentIntent: { create: mockPaymentIntentCreate },
    idempotencyRecord: {
      findUnique: mockIdempotencyFindUnique,
      create: mockIdempotencyCreate,
      delete: mockIdempotencyDelete,
    },
    $transaction: mockTransaction,
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');
const buildPaymentRouter = require('../src/routes/v1/paymentRoutes');

const baseIntent = {
  external_id: 'order-123',
  from: 'GSOURCE',
  to: 'GDESTINATION',
  amount: '25.00',
};

describe('payment intent creation idempotency', () => {
  // In-memory store emulating the unique constraint on the idempotency key.
  let idempotencyStore;

  beforeEach(() => {
    jest.clearAllMocks();
    idempotencyStore = new Map();

    mockPaymentIntentCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'intent-1', externalId: data.externalId, metadata: data.metadata }),
    );

    mockIdempotencyFindUnique.mockImplementation(({ where }) =>
      Promise.resolve(idempotencyStore.get(where.key) || null),
    );

    mockIdempotencyCreate.mockImplementation(({ data }) => {
      if (idempotencyStore.has(data.key)) {
        const err = new Error('Unique constraint failed on the fields: (`key`)');
        err.code = 'P2002';
        return Promise.reject(err);
      }
      const record = { ...data };
      idempotencyStore.set(data.key, record);
      return Promise.resolve(record);
    });

    mockIdempotencyDelete.mockImplementation(({ where }) => {
      idempotencyStore.delete(where.key);
      return Promise.resolve({});
    });

    // Transaction boundary: on failure, roll back any idempotency record
    // written during the transaction so no orphaned record remains.
    mockTransaction.mockImplementation(async (operations) => {
      const snapshot = new Map(idempotencyStore);
      try {
        return await Promise.all(operations);
      } catch (err) {
        idempotencyStore = snapshot;
        throw err;
      }
    });
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

  test('concurrent tabs sharing a key receive the original response with replay header', async () => {
    const app = buildApp();

    const payload = [{ ...baseIntent }];
    const responses = await Promise.all([
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'tab-shared').send(payload),
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'tab-shared').send(payload),
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'tab-shared').send(payload),
    ]);

    responses.forEach((res) => expect(res.status).toBe(201));
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);

    const replays = responses.filter((res) => res.headers['x-idempotent-replay'] === 'true');
    expect(replays.length).toBe(2);
    replays.forEach((res) => expect(res.body).toEqual(responses[0].body));
  });

  test('expired coordination key allows a new payment attempt', async () => {
    const app = buildApp();

    const payload = [{ ...baseIntent }];
    const first = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'tab-stale')
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.headers['x-idempotent-replay']).toBeUndefined();

    // Simulate the coordination window expiring so the key is no longer retained.
    jest.resetModules();
    const freshApp = buildApp();

    const second = await request(freshApp)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'tab-stale')
      .send(payload);

    expect(second.status).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(2);
  });
});
