'use strict';

const express = require('express');
const request = require('supertest');

const mockUserUpdateMany = jest.fn();
const mockUserFindMany = jest.fn();

const mockIdempotencyCreate = jest.fn();
const mockIdempotencyFindUnique = jest.fn();
const mockIdempotencyUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: { updateMany: mockUserUpdateMany, findMany: mockUserFindMany },
    idempotencyRecord: {
      create: mockIdempotencyCreate,
      findUnique: mockIdempotencyFindUnique,
      update: mockIdempotencyUpdate,
    },
    $transaction: mockTransaction,
  },
  isPrismaConnectionError: () => false,
}));

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');
const buildAdminRouter = require('../src/routes/v1/adminRoutes');

describe('admin block idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockUserFindMany.mockResolvedValue([{ username: 'alice*stellar' }]);

    // Default: no stored record yet, create succeeds, transaction runs the
    // callback with the same client so business + record writes share a tx.
    mockIdempotencyFindUnique.mockResolvedValue(null);
    mockIdempotencyCreate.mockResolvedValue({ id: 'rec-1' });
    mockIdempotencyUpdate.mockResolvedValue({ id: 'rec-1' });
    mockTransaction.mockImplementation(async (fn) =>
      typeof fn === 'function'
        ? fn({
            user: { updateMany: mockUserUpdateMany, findMany: mockUserFindMany },
            idempotencyRecord: {
              create: mockIdempotencyCreate,
              findUnique: mockIdempotencyFindUnique,
              update: mockIdempotencyUpdate,
            },
          })
        : Promise.all(fn),
    );
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/', buildAdminRouter(null));
    return app;
  };

  test('returns cached 2xx response on duplicate block requests', async () => {
    const app = buildApp();

    const first = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-1')
      .send({ address: 'GABC' });

    const second = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-1')
      .send({ address: 'GABC' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    // Handler must only run once; the duplicate is served from the stored outcome.
    expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockIdempotencyCreate).toHaveBeenCalledTimes(1);
    expect(second.body).toEqual(first.body);
  });

  test('replay returns the stored outcome even when the handler would differ', async () => {
    const app = buildApp();

    const first = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-stored')
      .send({ address: 'GABC' });

    // Simulate the persisted record now holding the original outcome.
    mockIdempotencyFindUnique.mockResolvedValue({
      id: 'rec-stored',
      key: 'block-key-stored',
      fingerprint: expect.anything(),
      status: 'completed',
      responseStatus: first.status,
      responseBody: first.body,
    });

    const second = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-stored')
      .send({ address: 'GABC' });

    expect(second.status).toBe(first.status);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
  });

  test('rejects a reused key with a mismatched request fingerprint', async () => {
    const app = buildApp();

    await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-fp')
      .send({ address: 'GABC' });

    const second = await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-fp')
      .send({ address: 'GDIFFERENT' });

    expect(second.status).toBe(409);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    // Mismatched fingerprint must not re-run the business command.
    expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
  });

  test('distinct keys run the handler again', async () => {
    const app = buildApp();

    await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-a')
      .send({ address: 'GABC' });
    await request(app)
      .post('/admin/block')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'block-key-b')
      .send({ address: 'GABC' });

    expect(mockUserUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockIdempotencyCreate).toHaveBeenCalledTimes(2);
  });

  test('ignores idempotency key on read-only admin GET endpoints', async () => {
    const app = buildApp();

    const first = await request(app)
      .get('/admin/audit-logs')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'audit-key');
    const second = await request(app)
      .get('/admin/audit-logs')
      .set('x-api-key', 'test-admin-key')
      .set(IDEMPOTENCY_HEADER, 'audit-key');

    expect(first.headers['x-idempotent-replay']).toBeUndefined();
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    // Read-only endpoints must not touch idempotency storage.
    expect(mockIdempotencyCreate).not.toHaveBeenCalled();
    expect(mockIdempotencyFindUnique).not.toHaveBeenCalled();
  });
});
