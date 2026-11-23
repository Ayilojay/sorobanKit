'use strict';

process.env.ADMIN_API_KEY = 'e2e-admin-key';

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));
jest.mock('pdfkit', () => jest.fn());

const mockDbUsers = new Map();

jest.mock('../../prismaClient', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }) => {
        let row = null;
        if (where.address) {
          for (const entry of mockDbUsers.values()) {
            if (entry.address === where.address) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const entry of mockDbUsers.values()) {
          if (entry.address === where.address) {
            const updated = { ...entry, ...data };
            mockDbUsers.set(entry.address, updated);
            count++;
          }
        }
        return { count };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const [address, entry] of mockDbUsers.entries()) {
          if (where.address && entry.address === where.address) {
            mockDbUsers.set(address, { ...entry, ...data });
            count++;
          }
        }
        return { count };
      }),
      findMany: jest.fn(async () => {
        return Array.from(mockDbUsers.values());
      }),
      count: jest.fn(async () => {
        return mockDbUsers.size;
      })
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([{ id: 'payment_1' }])
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, isPrismaConnectionError: () => false, getPrisma: () => ({ prisma, isPrismaConnectionError: () => false, withTransaction: async (cb) => cb(prisma) }), withTransaction: async (cb) => cb(prisma) };
});

const request = require('supertest');
const { app } = require('../../server');
const { e2ePrefix, purgeTestRecords } = require('./e2eHelpers');

const TEST_PREFIX = e2ePrefix();
const TEST_USER = `${TEST_PREFIX}admin`;

describe('E2E: Admin Flow', () => {
  // Runs even if beforeAll/beforeEach or a test fails, so no records leak
  // into the next run.
  afterAll(() => {
    purgeTestRecords(mockDbUsers, TEST_PREFIX);
  });

  beforeEach(() => {
    mockDbUsers.clear();
    mockDbUsers.set('GABC123XYZ456789ADMIN', {
      username: TEST_USER,
      address: 'GABC123XYZ456789ADMIN',
      flaggedAt: null,
      createdAt: new Date(),
    });
  });

  it('should allow admin to block a user and export users', async () => {
    // 1. Block User (operational permission)
    let res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'e2e-admin-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GABC123XYZ456789ADMIN');
    expect(res.body.flaggedAt).toBeDefined();

    // 2. Export Payments (read permission)
    res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'e2e-admin-key');

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe('payment_1');
  });

  it('should return 401 for unauthorized admin access', async () => {
    const res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'wrong-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(401);
  });

  it('should deny operational actions to a read-only key', async () => {
    const res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'e2e-read-only-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should deny configuration changes to an operational key', async () => {
    const res = await request(app)
      .post('/api/v1/admin/config')
      .set('x-api-key', 'e2e-admin-key')
      .send({ key: 'feeBps', value: 25 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should require step-up verification for treasury changes', async () => {
    const payload = { amount: '1000', asset: 'XLM', destination: 'GDEST123' };

    // Missing step-up token -> rejected, no state change.
    let res = await request(app)
      .post('/api/v1/admin/treasury/withdraw')
      .set('x-api-key', 'e2e-admin-key')
      .send(payload);
    expect(res.status).toBe(428);

    // Request a step-up challenge bound to the action + payload hash.
    res = await request(app)
      .post('/api/v1/admin/step-up/challenge')
      .set('x-api-key', 'e2e-admin-key')
      .send({ action: 'treasury.withdraw', payload });
    expect(res.status).toBe(200);
    expect(res.body.challengeId).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();

    const { challengeId } = res.body;

    // Wrong payload hash -> rejected.
    res = await request(app)
      .post('/api/v1/admin/treasury/withdraw')
      .set('x-api-key', 'e2e-admin-key')
      .set('x-step-up-token', challengeId)
      .send({ ...payload, amount: '9999' });
    expect(res.status).toBe(409);

    // Correct token + payload -> succeeds.
    res = await request(app)
      .post('/api/v1/admin/treasury/withdraw')
      .set('x-api-key', 'e2e-admin-key')
      .set('x-step-up-token', challengeId)
      .send(payload);
    expect(res.status).toBe(200);

    // Token is single-use: replaying it fails.
    res = await request(app)
      .post('/api/v1/admin/treasury/withdraw')
      .set('x-api-key', 'e2e-admin-key')
      .set('x-step-up-token', challengeId)
      .send(payload);
    expect(res.status).toBe(409);
  });

  it('should reject expired step-up challenges', async () => {
    const payload = { contractId: 'CABC123', wasmHash: 'deadbeef' };

    let res = await request(app)
      .post('/api/v1/admin/step-up/challenge')
      .set('x-api-key', 'e2e-admin-key')
      .send({ action: 'contract.upgrade', payload, ttlSeconds: -1 });
    expect(res.status).toBe(200);

    res = await request(app)
      .post('/api/v1/admin/contracts/upgrade')
      .set('x-api-key', 'e2e-admin-key')
      .set('x-step-up-token', res.body.challengeId)
      .send(payload);
    expect(res.status).toBe(409);
  });

  it('should record audit evidence for sensitive decisions', async () => {
    const { prisma } = require('../../prismaClient');
    prisma.auditLog.create.mockClear();

    await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'e2e-admin-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(prisma.auditLog.create).toHaveBeenCalled();
    const entry = prisma.auditLog.create.mock.calls[0][0].data;
    expect(entry.action).toBe('admin.block');
    expect(entry.outcome).toBe('allowed');
  });
});
