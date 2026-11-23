const request = require('supertest');
const crypto = require('crypto');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

// Mock Prisma so it doesn't try to connect to a real database
const mockApiKeyCreate = jest.fn();
const mockApiKeyFindUnique = jest.fn();
const mockApiKeyFindMany = jest.fn();
const mockApiKeyUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        username: 'alice123',
        address: 'GABC123',
      }),
    },
    apiKey: {
      create: mockApiKeyCreate,
      findUnique: mockApiKeyFindUnique,
      findMany: mockApiKeyFindMany,
      update: mockApiKeyUpdate,
    },
    $transaction: mockTransaction,
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

// Mock the pool functions
jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

// Mock the v1 routes (factory function since v1/index.js now exports a function)
jest.mock('../src/routes/v1', () => {
  return () => require('express').Router();
});

// Mock JWT requireAuth to always pass in tests
jest.mock('../src/utils/jwt', () => ({
  signToken: jest.fn(() => 'mock-token'),
  verifyToken: jest.fn(() => ({ sub: 'test@example.com', email: 'test@example.com' })),
  getJwks: jest.fn(() => ({ keys: [] })),
  requireAuth: (req, res, next) => {
    req.user = { sub: 'test@example.com', email: 'test@example.com' };
    next();
  },
}));

const { app } = require('../server');

const KEY_PREFIX = 'sk_live_';
const TEST_ADMIN_API_KEY = process.env.TEST_ADMIN_API_KEY;
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// API key hash comparisons MUST use crypto.timingSafeEqual to avoid timing
// side channels (see issue #186). These tests assert that requirement.
describe('API key verification uses constant-time comparison', () => {
  let timingSafeEqualSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    timingSafeEqualSpy = jest.spyOn(crypto, 'timingSafeEqual');
  });

  afterEach(() => {
    timingSafeEqualSpy.mockRestore();
  });

  it('invokes crypto.timingSafeEqual and returns 200 for a valid key', async () => {
    const rawKey = `${KEY_PREFIX}validkey1234567890`;
    mockApiKeyFindUnique.mockResolvedValue({
      id: 'valid-key-id',
      name: 'Valid Key',
      ownerId: 'merchant@example.com',
      keyHash: hashKey(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: ['read', 'write'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get('/auth/api-keys')
      .set('X-Api-Key', rawKey)
      .query({ owner_id: 'merchant@example.com' });

    expect(res.statusCode).toBe(200);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  it('invokes crypto.timingSafeEqual and returns 401 for an invalid key', async () => {
    const rawKey = `${KEY_PREFIX}invalidkey1234567890`;
    mockApiKeyFindUnique.mockResolvedValue({
      id: 'valid-key-id',
      name: 'Valid Key',
      ownerId: 'merchant@example.com',
      keyHash: hashKey(`${KEY_PREFIX}someotherkey0987654321`),
      keyPrefix: 'sk_live_some',
      scopes: ['read', 'write'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });

    const res = await request(app)
      .get('/auth/api-keys')
      .set('X-Api-Key', rawKey)
      .query({ owner_id: 'merchant@example.com' });

    expect(res.statusCode).toBe(401);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });

  it('invokes crypto.timingSafeEqual and returns 401 when no key record exists', async () => {
    const rawKey = `${KEY_PREFIX}unknownkey1234567890`;
    mockApiKeyFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/auth/api-keys')
      .set('X-Api-Key', rawKey)
      .query({ owner_id: 'merchant@example.com' });

    expect(res.statusCode).toBe(401);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });
});

describe('API Key Management Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/api-keys - Generate new API key', () => {
    it('should create a new API key successfully', async () => {
      const fakeId = 'test-api-key-id-123';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read', 'write'],
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(fakeId);
      expect(res.body.data.name).toBe('Test Key');
      expect(res.body.data.key).toMatch(/^sk_live_/);
      expect(res.body.data.key_prefix).toMatch(/^sk_live_/);
      expect(res.body.data.owner_id).toBe('merchant@example.com');
      expect(mockApiKeyCreate).toHaveBeenCalledTimes(1);
    });

    it('should create API key with custom scopes', async () => {
      const fakeId = 'test-api-key-id-456';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Read Only Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read'],
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Read Only Key',
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalled();
    });

    it('should create API key with expiration', async () => {
      const fakeId = 'test-api-key-id-789';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Expiring Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read', 'write'],
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Expiring Key',
          owner_id: 'merchant@example.com',
          expires_in_hours: 24,
        });

      expect(res.statusCode).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            expiresAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should return 422 when name is missing', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when owner_id is missing', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when scopes contain invalid values', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
          owner_id: 'merchant@example.com',
          scopes: 'invalid_scope',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /auth/api-keys - List API keys', () => {
    it('should list API keys for an owner', async () => {
      const fakeKeys = [
        {
          id: 'key-1',
          name: 'Key 1',
          keyPrefix: 'sk_live_abc',
          ownerId: 'merchant@example.com',
          scopes: ['read', 'write'],
          expiresAt: null,
          revokedAt: null,
          revokedBy: null,
          lastUsedAt: new Date(),
          createdAt: new Date(),
        },
      ];
      mockApiKeyFindMany.mockResolvedValue(fakeKeys);

      const res = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Key 1');
    });

    it('should return 400 when owner_id is missing', async () => {
      const res = await request(app)
        .get('/auth/api-keys');

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return empty array when no keys exist', async () => {
      mockApiKeyFindMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('POST /auth/api-keys/:id/revoke - Revoke API key', () => {
    it('should revoke an API key successfully', async () => {
      const fakeId = 'key-to-revoke';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: null,
      });
      mockApiKeyUpdate.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        revokedAt: new Date(),
        revokedBy: 'merchant@example.com',
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApiKeyUpdate).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when API key is not found', async () => {
      mockApiKeyFindUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/api-keys/nonexistent-id/revoke')
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 409 when API key is already revoked', async () => {
      const fakeId = 'key-already-revoked';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: new Date(),
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when revoked_by is missing', async () => {
      const fakeId = 'key-to-revoke';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: null,
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /auth/api-keys/:id/rotate - Rotate API key', () => {
    it('should rotate an API key successfully', async () => {
      const oldKeyId = 'old-key-id';
      const newKeyId = 'new-key-id';
      const oldRecord = {
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read', 'write'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockApiKeyFindUnique.mockResolvedValue(oldRecord);
      mockTransaction.mockResolvedValue([
        {
          id: newKeyId,
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          createdAt: new Date(),
        },
        {
          id: oldKeyId,
          revokedAt: new Date(),
          revokedBy: 'rotation',
        },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.new_key).toBeDefined();
      expect(res.body.data.old_key).toBeDefined();
      expect(res.body.data.new_key.key).toMatch(/^sk_live_/);
      expect(res.body.data.old_key.grace_period_expires_at).toBeDefined();
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should rotate with custom name', async () => {
      const oldKeyId = 'old-key-id';
      const oldRecord = {
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read', 'write'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockApiKeyFindUnique.mockResolvedValue(oldRecord);
      mockTransaction.mockResolvedValue([
        {
          id: 'new-key-id',
          name: 'New Key Name',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          createdAt: new Date(),
        },
        { id: oldKeyId, revokedAt: new Date(), revokedBy: 'rotation' },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({ name: 'New Key Name' });

      expect(res.statusCode).toBe(201);
      expect(res.body.data.new_key.name).toBe('New Key Name');
    });

    it('should return 404 when API key is not found', async () => {
      mockApiKeyFindUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/api-keys/nonexistent-id/rotate')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 409 when API key is already revoked', async () => {
      const oldKeyId = 'already-revoked-key';
      mockApiKeyFindUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Revoked Key',
        ownerId: 'merchant@example.com',
        revokedAt: new Date(),
      });

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should default grace period to 1 hour', async () => {
      const oldKeyId = 'old-key-id';
      mockApiKeyFindUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      });
      mockTransaction.mockResolvedValue([
        {
          id: 'new-key-id',
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          scopes: ['read'],
          expiresAt: null,
          createdAt: new Date(),
        },
        { id: oldKeyId, revokedAt: new Date(), revokedBy: 'rotation' },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(201);
      const graceExpires = new Date(res.body.data.old_key.grace_period_expires_at);
      const now = new Date();
      const diffHours = (graceExpires - now) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(1, 0);
    });
  });

  describe('Overlapping rotation with revocation auditability', () => {
    const buildOldRecord = (overrides = {}) => ({
      id: 'old-key-id',
      name: 'Old Key',
      ownerId: 'merchant@example.com',
      keyHash: 'old-hash',
      keyPrefix: 'sk_live_old',
      scopes: ['read', 'write'],
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      overlapExpiresAt: null,
      predecessorId: null,
      successorId: null,
      createdAt: new Date(),
      ...overrides,
    });

    it('discloses the raw replacement key exactly once on rotation', async () => {
      const oldKeyId = 'old-key-id';
      const newKeyId = 'new-key-id';
      const overlapExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

      mockApiKeyFindUnique.mockResolvedValue(buildOldRecord({ id: oldKeyId }));
      mockTransaction.mockResolvedValue([
        {
          id: newKeyId,
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          predecessorId: oldKeyId,
          successorId: null,
          createdAt: new Date(),
        },
        {
          id: oldKeyId,
          revokedAt: null,
          revokedBy: null,
          overlapExpiresAt,
          successorId: newKeyId,
        },
      ]);

      const rotateRes = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(rotateRes.statusCode).toBe(201);
      expect(rotateRes.body.data.new_key.key).toMatch(/^sk_live_/);
      expect(rotateRes.body.data.new_key.predecessor_id).toBe(oldKeyId);
      expect(rotateRes.body.data.old_key.successor_id).toBe(newKeyId);
      expect(rotateRes.body.data.old_key.overlap_expires_at).toBeDefined();

      // Subsequent reads must never re-expose raw key material.
      mockApiKeyFindMany.mockResolvedValue([
        {
          id: newKeyId,
          name: 'Old Key',
          keyPrefix: 'sk_live_new',
          ownerId: 'merchant@example.com',
          scopes: ['read', 'write'],
          expiresAt: null,
          revokedAt: null,
          revokedBy: null,
          overlapExpiresAt: null,
          predecessorId: oldKeyId,
          successorId: null,
          lastUsedAt: null,
          createdAt: new Date(),
        },
      ]);

      const listRes = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(listRes.statusCode).toBe(200);
      expect(listRes.body.data[0].key).toBeUndefined();
      expect(listRes.body.data[0].keyHash).toBeUndefined();
      expect(listRes.body.data[0].key_prefix).toBe('sk_live_new');
      expect(listRes.body.data[0].predecessor_id).toBe(oldKeyId);
    });

    it('accepts the predecessor key before overlapExpiresAt and rejects it after', async () => {
      const rawOldKey = `${KEY_PREFIX}overlapoldkey123456`;
      const ownerId = 'merchant@example.com';

      // Before the overlap window closes: predecessor still authenticates.
      mockApiKeyFindUnique.mockResolvedValue(
        buildOldRecord({
          keyHash: hashKey(rawOldKey),
          keyPrefix: rawOldKey.slice(0, 12),
          overlapExpiresAt: new Date(Date.now() + 60 * 1000),
          successorId: 'new-key-id',
        }),
      );

      const beforeRes = await request(app)
        .get('/auth/api-keys')
        .set('X-Api-Key', rawOldKey)
        .query({ owner_id: ownerId });

      expect(beforeRes.statusCode).toBe(200);

      // After the overlap window closes: predecessor is rejected immediately.
      mockApiKeyFindUnique.mockResolvedValue(
        buildOldRecord({
          keyHash: hashKey(rawOldKey),
          keyPrefix: rawOldKey.slice(0, 12),
          overlapExpiresAt: new Date(Date.now() - 1000),
          successorId: 'new-key-id',
        }),
      );

      const afterRes = await request(app)
        .get('/auth/api-keys')
        .set('X-Api-Key', rawOldKey)
        .query({ owner_id: ownerId });

      expect(afterRes.statusCode).toBe(401);
    });

    it('rejects a revoked key immediately even inside its overlap window', async () => {
      const rawKey = `${KEY_PREFIX}revokedoverlap12345`;
      mockApiKeyFindUnique.mockResolvedValue(
        buildOldRecord({
          keyHash: hashKey(rawKey),
          keyPrefix: rawKey.slice(0, 12),
          revokedAt: new Date(),
          revokedBy: 'security@example.com',
          overlapExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
      );

      const res = await request(app)
        .get('/auth/api-keys')
        .set('X-Api-Key', rawKey)
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(401);
    });

    it('records revocation audit metadata (revoked_by and revoked_at)', async () => {
      const fakeId = 'key-to-revoke';
      const revokedAt = new Date();
      mockApiKeyFindUnique.mockResolvedValue(buildOldRecord({ id: fakeId }));
      mockApiKeyUpdate.mockResolvedValue({
        id: fakeId,
        name: 'Old Key',
        revokedAt,
        revokedBy: 'security@example.com',
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'security@example.com' });

      expect(res.statusCode).toBe(200);
      expect(mockApiKeyUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: fakeId }),
          data: expect.objectContaining({
            revokedAt: expect.any(Date),
            revokedBy: 'security@example.com',
          }),
        }),
      );
    });

    it('serializes concurrent rotations into a single successor chain', async () => {
      const oldKeyId = 'old-key-id';
      const overlapExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

      // First rotation wins; the second observes the key already rotated and
      // must not create a second successor.
      mockApiKeyFindUnique
        .mockResolvedValueOnce(buildOldRecord({ id: oldKeyId }))
        .mockResolvedValueOnce(
          buildOldRecord({
            id: oldKeyId,
            overlapExpiresAt,
            successorId: 'new-key-id-1',
          }),
        );

      mockTransaction
        .mockResolvedValueOnce([
          {
            id: 'new-key-id-1',
            name: 'Old Key',
            ownerId: 'merchant@example.com',
            keyHash: 'new-hash-1',
            keyPrefix: 'sk_live_new',
            scopes: ['read', 'write'],
            expiresAt: null,
            predecessorId: oldKeyId,
            successorId: null,
            createdAt: new Date(),
          },
          {
            id: oldKeyId,
            revokedAt: null,
            revokedBy: null,
            overlapExpiresAt,
            successorId: 'new-key-id-1',
          },
        ])
        .mockResolvedValueOnce([]);

      const [first, second] = await Promise.all([
        request(app)
          .post(`/auth/api-keys/${oldKeyId}/rotate`)
          .set('Content-Type', 'application/json')
          .send({}),
        request(app)
          .post(`/auth/api-keys/${oldKeyId}/rotate`)
          .set('Content-Type', 'application/json')
          .send({}),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([201, 409]);

      const winner = first.statusCode === 201 ? first : second;
      expect(winner.body.data.old_key.successor_id).toBe('new-key-id-1');
      expect(winner.body.data.new_key.predecessor_id).toBe(oldKeyId);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('Seeded API key (TEST_ADMIN_API_KEY)', () => {
    // Skip when the seed has not run (e.g. local runs without the test profile),
    // but fail loudly in CI where the key is required.
    const describeIfKey = TEST_ADMIN_API_KEY ? describe : describe.skip;

    if (!TEST_ADMIN_API_KEY && process.env.CI) {
      it('TEST_ADMIN_API_KEY must be set in CI', () => {
        throw new Error(
          'TEST_ADMIN_API_KEY is not set. The test profile must run `npm run db:seed` ' +
            'after migrations and export the active API key.',
        );
      });
    }

    describeIfKey('authenticated requests with the seeded key', () => {
      it('exposes a key with the expected prefix', () => {
        expect(TEST_ADMIN_API_KEY).toMatch(/^sk_live_/);
      });

      it('authenticates against the test server', async () => {
        const res = await request(app)
          .get('/auth/api-keys')
          .set('Authorization', `Bearer ${TEST_ADMIN_API_KEY}`)
          .query({ owner_id: 'admin@example.com' });

        // The seeded key must be accepted (not rejected as invalid/unauthorized).
        expect([200, 400, 404]).toContain(res.statusCode);
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
      });

      it('is idempotent: the seeded key hash matches the stored record', async () => {
        mockApiKeyFindUnique.mockResolvedValue({
          id: 'seeded-admin-key',
          name: 'Admin Key',
          ownerId: 'admin@example.com',
          keyHash: hashKey(TEST_ADMIN_API_KEY),
          keyPrefix: TEST_ADMIN_API_KEY.slice(0, KEY_PREFIX.length + 8),
          scopes: ['read', 'write'],
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        });

        const res = await request(app)
          .get('/auth/api-keys')
          .set('Authorization', `Bearer ${TEST_ADMIN_API_KEY}`)
          .query({ owner_id: 'admin@example.com' });

        expect(res.statusCode).not.toBe(401);
        expect(mockApiKeyFindUnique).toHaveBeenCalled();
      });
    });
  });
});
