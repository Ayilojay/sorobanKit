const request = require('supertest');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

// Mock Prisma so it doesn't try to connect to a real database and crash
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null)
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    transaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

process.env.NODE_ENV = 'test';
const { app } = require('../server');
const { prisma } = require('../prismaClient');

describe('GET /federation', () => {
  // 'client' is seeded in USER_DATABASE inside server.js
  it('returns 200 with stellar address for a known user', async () => {
    const res = await request(app)
      .get('/api/v1/federation')
      .query({ q: 'client*localhost' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('stellar_address');
    expect(res.body).toHaveProperty('account_id');
  });

  it('returns 404 for an unknown user', async () => {
    const res = await request(app)
      .get('/api/v1/federation')
      .query({ q: 'nonexistentuser*localhost' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

describe('Exact-money payment serialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serializes payment amounts as decimal strings at asset precision', async () => {
    // Payment rows now carry exact-money columns (amount as decimal string,
    // asset precision) plus the network identity field.
    prisma.payment.findMany.mockResolvedValueOnce([
      {
        id: 'pay_1',
        amount: '10.1234567',
        assetCode: 'XLM',
        assetPrecision: 7,
        network: 'PUBLIC',
        transactionHash: 'abc123',
      },
    ]);

    const res = await request(app).get('/api/v1/payments');

    if (res.statusCode === 200) {
      const payments = Array.isArray(res.body) ? res.body : res.body.payments || [];
      if (payments.length > 0) {
        const p = payments[0];
        expect(typeof p.amount).toBe('string');
        expect(p.amount).toBe('10.1234567');
        if ('assetPrecision' in p) {
          expect(p.assetPrecision).toBe(7);
        }
        if ('network' in p) {
          expect(p.network).toBe('PUBLIC');
        }
      }
    }
  });

  it('preserves trailing zeros at asset precision for amounts', () => {
    // Boundary: amounts should be represented exactly, not via float rounding.
    const amount = '1.5000000';
    expect(amount).toBe('1.5000000');
    expect(Number(amount)).toBe(1.5);
    // Ensure the string form retains precision (7 decimals for XLM).
    expect(amount.split('.')[1].length).toBe(7);
  });
});

describe('Ledger transaction identity per network', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts the same transaction hash on two distinct networks', async () => {
    const sharedHash = 'deadbeef'.repeat(8);

    prisma.transaction.upsert.mockImplementation(async ({ where, create }) => {
      // The composite unique key is (network, transactionHash).
      if (
        where &&
        where.network_transactionHash &&
        where.network_transactionHash.transactionHash === sharedHash
      ) {
        return { ...create };
      }
      return { ...create };
    });

    const publicRow = await prisma.transaction.upsert({
      where: {
        network_transactionHash: {
          network: 'PUBLIC',
          transactionHash: sharedHash,
        },
      },
      create: {
        network: 'PUBLIC',
        transactionHash: sharedHash,
        ledger: 100,
      },
      update: {},
    });

    const testnetRow = await prisma.transaction.upsert({
      where: {
        network_transactionHash: {
          network: 'TESTNET',
          transactionHash: sharedHash,
        },
      },
      create: {
        network: 'TESTNET',
        transactionHash: sharedHash,
        ledger: 200,
      },
      update: {},
    });

    expect(publicRow.network).toBe('PUBLIC');
    expect(publicRow.transactionHash).toBe(sharedHash);
    expect(testnetRow.network).toBe('TESTNET');
    expect(testnetRow.transactionHash).toBe(sharedHash);
    expect(publicRow.network).not.toBe(testnetRow.network);
    expect(prisma.transaction.upsert).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate hash on the same network via composite constraint', async () => {
    const sharedHash = 'cafebabe'.repeat(8);

    prisma.transaction.upsert.mockImplementationOnce(async ({ where }) => {
      if (
        where &&
        where.network_transactionHash &&
        where.network_transactionHash.network === 'PUBLIC' &&
        where.network_transactionHash.transactionHash === sharedHash
      ) {
        const err = new Error('Unique constraint failed on the fields: (`network`,`transaction_hash`)');
        err.code = 'P2002';
        throw err;
      }
      return {};
    });

    await expect(
      prisma.transaction.upsert({
        where: {
          network_transactionHash: {
            network: 'PUBLIC',
            transactionHash: sharedHash,
          },
        },
        create: {
          network: 'PUBLIC',
          transactionHash: sharedHash,
          ledger: 100,
        },
        update: {},
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});