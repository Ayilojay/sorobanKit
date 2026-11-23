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

  test('first request persists an idempotency record with hashed key and fingerprint', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-persist')
      .send([baseIntent]);

    expect(res.status).toBe(201);
    expect(mockIdempotencyCreate).toHaveBeenCalledTimes(1);
    const { data } = mockIdempotencyCreate.mock.calls[0][0];
    expect(data.key).not.toBe('pay-persist');
    expect(typeof data.key).toBe('string');
    expect(data.fingerprint).toEqual(expect.any(String));
    expect(data.fingerprint).not.toBe(JSON.stringify([baseIntent]));
    expect(idempotencyStore.size).toBe(1);
  });

  test('concurrent duplicate requests converge on a single business operation', async () => {
    const app = buildApp();

    const payload = [{ ...baseIntent }];
    const responses = await Promise.all([
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'pay-race').send(payload),
      request(app).post('/payments/bulk').set(IDEMPOTENCY_HEADER, 'pay-race').send(payload),
    ]);

    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(idempotencyStore.size).toBe(1);
  });

  test('rejects replay when the request fingerprint does not match', async () => {
    const app = buildApp();

    await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-fingerprint')
      .send([baseIntent]);

    const mismatch = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-fingerprint')
      .send([{ ...baseIntent, amount: '99.00' }]);

    expect(mismatch.status).toBe(409);
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  test('rolls back the idempotency record when the business command fails', async () => {
    const app = buildApp();
    mockPaymentIntentCreate.mockRejectedValueOnce(new Error('business failure'));

    const res = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-rollback')
      .send([baseIntent]);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(idempotencyStore.size).toBe(0);

    // A retry with the same key must be able to run the business command again.
    mockPaymentIntentCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'intent-1', externalId: data.externalId, metadata: data.metadata }),
    );
    const retry = await request(app)
      .post('/payments/bulk')
      .set(IDEMPOTENCY_HEADER, 'pay-rollback')
      .send([baseIntent]);

    expect(retry.status).toBe(201);
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(2);
  });
});
