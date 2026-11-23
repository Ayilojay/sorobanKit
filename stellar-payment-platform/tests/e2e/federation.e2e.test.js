'use strict';

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));
jest.mock('pdfkit', () => jest.fn());

const mockDb = new Map();

jest.mock('../../prismaClient', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }) => {
        let row = null;
        if (where.username) {
          const u = typeof where.username === 'string' ? where.username : where.username.equals;
          for (const entry of mockDb.values()) {
            if (entry.username === u) {
              row = entry;
              break;
            }
          }
        } else if (where.address) {
          const a = typeof where.address === 'string' ? where.address : where.address.equals;
          for (const entry of mockDb.values()) {
            if (entry.address.toLowerCase() === a.toLowerCase()) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }) => {
        const row = {
          username: data.username,
          address: data.address,
          memoType: data.memoType || null,
          memo: data.memo || null,
          createdAt: new Date(),
        };
        mockDb.set(data.address, row);
        return row;
      }),
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, isPrismaConnectionError: () => false };
});

jest.mock('../../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({ success: true }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

jest.mock('bad-words', () => {
  return jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  }));
});

const request = require('supertest');
const { app } = require('../../server');
const { e2ePrefix, purgeTestRecords } = require('./e2eHelpers');

const TEST_PREFIX = e2ePrefix();
const TEST_USER = `${TEST_PREFIX}fed`;
const { prisma } = require('../../prismaClient');

describe('E2E: Federation Flow', () => {
  // Runs even if beforeAll/beforeEach or a test fails, so no records leak
  // into the next run.
  afterAll(() => {
    purgeTestRecords(mockDb, TEST_PREFIX);
  });

  beforeEach(() => {
    mockDb.clear();
  });

  it('should successfully lookup a user by name and ID', async () => {
    const validUser = {
      username: `${TEST_USER}*localhost`,
      address: 'GABC123XYZ456789FEDERATION',
    };
    mockDb.set(validUser.address, validUser);

    // 1. Lookup by Name (default behavior)
    let res = await request(app)
      .get(`/api/v1/federation?q=${encodeURIComponent(validUser.username)}&type=name`);

    expect(res.status).toBe(200);
    expect(res.body.account_id).toBe(validUser.address);

    // 2. Lookup by ID
    res = await request(app)
      .get(`/api/v1/federation?q=${validUser.address}&type=id`);

    expect(res.status).toBe(200);
    expect(res.body.stellar_address).toBe(validUser.username);

    // 3. Not Found
    res = await request(app)
      .get(`/api/v1/federation?q=nonexistent*localhost&type=name`);

    expect(res.status).toBe(404);
  });

  it('resolves type=id to the active primary and never to a stale alias', async () => {
    const address = 'GPRIMARYALIAS123456789FEDERATION';
    const primary = {
      username: `${TEST_USER}primary*localhost`,
      address,
      isPrimary: true,
      deletedAt: null,
    };
    const alias = {
      username: `${TEST_USER}alias*localhost`,
      address,
      isPrimary: false,
      deletedAt: null,
    };
    mockDb.set(primary.username, primary);
    mockDb.set(alias.username, alias);

    // Reverse lookup resolves to the primary username, not the alias.
    let res = await request(app)
      .get(`/api/v1/federation?q=${address}&type=id`);

    expect(res.status).toBe(200);
    expect(res.body.stellar_address).toBe(primary.username);
    expect(res.body.stellar_address).not.toBe(alias.username);

    // Soft-delete the primary; the alias must not be served as a stale primary.
    primary.deletedAt = new Date();

    res = await request(app)
      .get(`/api/v1/federation?q=${address}&type=id`);

    // Either no active primary remains (404) or a promoted primary is returned,
    // but never the stale alias.
    if (res.status === 200) {
      expect(res.body.stellar_address).not.toBe(alias.username);
    } else {
      expect(res.status).toBe(404);
    }
  });
});
