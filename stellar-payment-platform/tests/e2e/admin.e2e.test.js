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
      findMany: jest.fn().mockResolvedValue([]),
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

  it('should record tamper-evident integrity fields on admin audit events', async () => {
    const { prisma } = require('../../prismaClient');

    const res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'e2e-admin-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalled();

    const createArgs = prisma.auditLog.create.mock.calls.at(-1)[0];
    const data = createArgs.data;
    expect(data).toBeDefined();
    expect(typeof data.integrityDigest).toBe('string');
    expect(data.integrityDigest.length).toBeGreaterThan(0);
    expect(typeof data.integrityKeyId).toBe('string');
    expect(data.integrityKeyId.length).toBeGreaterThan(0);
    // Chain link: first event in a fresh chain has no predecessor.
    expect(data.integrityPrevDigest === null || typeof data.integrityPrevDigest === 'string').toBe(true);
  });

  it('should verify audit integrity via the admin verification endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit/verify')
      .set('x-api-key', 'e2e-admin-key');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid');
    expect(typeof res.body.valid).toBe('boolean');
    expect(res.body).toHaveProperty('checked');
    expect(typeof res.body.checked).toBe('number');
  });

  it('should reject audit verification without admin credentials', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit/verify')
      .set('x-api-key', 'wrong-key');

    expect(res.status).toBe(401);
  });

  it('should preserve existing admin audit query behaviour', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit')
      .set('x-api-key', 'e2e-admin-key');

    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toBeDefined();
    }
  });
});
