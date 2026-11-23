'use strict';

/**
 * tests/audit-log.test.js
 *
 * Tests for Admin Audit Logging System (issue #495).
 */

const request = require('supertest');

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockAuditLogCreate = jest.fn().mockResolvedValue({});
const mockAuditLogFindMany = jest.fn().mockResolvedValue([]);
const mockUserUpdateMany = jest.fn();
const mockUserFindMany = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: mockUserFindMany,
      count: jest.fn(),
      create: jest.fn(),
      updateMany: mockUserUpdateMany,
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: mockAuditLogCreate,
      findMany: mockAuditLogFindMany,
      count: jest.fn(),
    },
    paymentIntent: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

// Load app and helpers after mocks are in place.
const { app } = require('../server');
const {
  redactSensitiveData,
  extractUserId,
  extractIpAddress,
  createAuditLogMiddleware,
  SENSITIVE_KEYS,
} = require('../src/middleware/auditLog');
const {
  canonicalize,
  computeDigest,
  verifyChain,
  AuditIntegrityChain,
} = require('../src/audit/integrity');

describe('Admin Audit Logging System', () => {
  beforeEach(() => {
    mockAuditLogCreate.mockClear();
    mockAuditLogFindMany.mockClear();
    mockUserUpdateMany.mockReset();
    mockUserFindMany.mockReset();
  });

  describe('redactSensitiveData', () => {
    it('redacts sensitive fields in top-level object', () => {
      const input = {
        username: 'alice',
        password: 'supersecretpassword',
        apiKey: 'key_12345',
        secret: 'mysecret',
        token: 'jwt.token.here',
        signature: 'sig_abc',
        normalField: 'hello',
      };

      const redacted = redactSensitiveData(input);
      expect(redacted).toEqual({
        username: 'alice',
        password: '[REDACTED]',
        apiKey: '[REDACTED]',
        secret: '[REDACTED]',
        token: '[REDACTED]',
        signature: '[REDACTED]',
        normalField: 'hello',
      });
    });

    it('redacts sensitive fields in deeply nested structures', () => {
      const input = {
        admin: {
          profile: {
            name: 'Admin',
            password: 'secretpassword',
          },
          tokens: [
            { id: 1, token: 'token1' },
            { id: 2, token: 'token2', name: 'api-token' },
          ],
        },
      };

      const redacted = redactSensitiveData(input);
      expect(redacted.admin.profile.password).toBe('[REDACTED]');
      expect(redacted.admin.tokens[0].token).toBe('[REDACTED]');
      expect(redacted.admin.tokens[1].token).toBe('[REDACTED]');
      expect(redacted.admin.tokens[1].name).toBe('api-token');
    });

    it('redacts a deeply nested password field', () => {
      const input = { user: { profile: { password: 'hunter2', name: 'Alice' } } };

      const redacted = redactSensitiveData(input);
      expect(redacted.user.profile.password).toBe('[REDACTED]');
      expect(redacted.user.profile.name).toBe('Alice');
    });

    it('redacts sensitive keys in arrays of objects while preserving other fields', () => {
      const input = {
        tokens: [
          { token: 'a' },
          { token: 'b', name: 'api-token' },
        ],
      };

      const redacted = redactSensitiveData(input);
      expect(redacted.tokens[0].token).toBe('[REDACTED]');
      expect(redacted.tokens[1].token).toBe('[REDACTED]');
      expect(redacted.tokens[1].name).toBe('api-token');
    });

    it('does not mutate the original input object', () => {
      const input = { user: { password: 'hunter2' } };
      redactSensitiveData(input);
      expect(input.user.password).toBe('hunter2');
    });

    it('exposes the shared SENSITIVE_KEYS constant with the expected keys', () => {
      expect(Array.isArray(SENSITIVE_KEYS)).toBe(true);
      expect(SENSITIVE_KEYS).toEqual(
        expect.arrayContaining([
          'password',
          'secret',
          'apiKey',
          'token',
          'signature',
          'privateKey',
          'seed',
        ])
      );
    });

    it('handles primitive, null, and undefined values safely', () => {
      expect(redactSensitiveData(null)).toBeNull();
      expect(redactSensitiveData(undefined)).toBeUndefined();
      expect(redactSensitiveData(123)).toBe(123);
      expect(redactSensitiveData('regular string')).toBe('regular string');
    });

    it('parses and redacts JSON strings if present', () => {
      const jsonStr = JSON.stringify({ password: 'secret', name: 'test' });
      const redacted = redactSensitiveData(jsonStr);
      const parsed = JSON.parse(redacted);
      expect(parsed.password).toBe('[REDACTED]');
      expect(parsed.name).toBe('test');
    });
  });

  describe('extractUserId & extractIpAddress', () => {
    it('extracts user ID from user object, headers, or query', () => {
      expect(extractUserId({ user: { id: 'usr-123' } })).toBe('usr-123');
      expect(extractUserId({ user: { username: 'admin_bob' } })).toBe('admin_bob');
      expect(extractUserId({ headers: { 'x-user-id': 'u-999' } })).toBe('u-999');
      expect(extractUserId({ headers: { 'x-admin-id': 'adm-777' } })).toBe('adm-777');
      expect(extractUserId({ headers: { 'x-api-key': 'test-key' } })).toBe('admin');
      expect(extractUserId({ headers: {}, query: { api_key: 'test-key' } })).toBe('admin');
      expect(extractUserId({ headers: {} })).toBe('anonymous');
    });

    it('extracts client IP from x-forwarded-for or request ip', () => {
      expect(extractIpAddress({ headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } })).toBe('198.51.100.1');
      expect(extractIpAddress({ headers: {}, ip: '203.0.113.195' })).toBe('203.0.113.195');
      expect(extractIpAddress({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1');
      expect(extractIpAddress({ headers: {} })).toBe('unknown');
    });
  });

  describe('Audit Log Middleware Integration', () => {
    it('records an audit log for mutating admin actions (POST /admin/block)', async () => {
      mockUserUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockUserFindMany.mockResolvedValueOnce([{ username: 'alice' }]);

      const res = await request(app)
        .post('/api/v1/admin/block')
        .set('x-api-key', 'test-admin-key')
        .set('x-user-id', 'admin-user-1')
        .send({
          address: 'GABC1234567890123456789012345678901234567890123456789012',
          secret: 'should-be-redacted',
        });

      expect(res.status).toBe(200);

      // Wait a tick for async setImmediate callback in middleware
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          method: 'POST',
          action: expect.stringMatching(/POST.*\/admin\/block/),
          userId: 'admin-user-1',
          statusCode: 200,
          payload: expect.any(String),
        }),
      });

      const loggedPayload = JSON.parse(mockAuditLogCreate.mock.calls[0][0].data.payload);
      expect(loggedPayload.secret).toBe('[REDACTED]');
      expect(loggedPayload.address).toBe('GABC1234567890123456789012345678901234567890123456789012');
    });

    it('does not log non-mutating requests (GET /admin/export)', async () => {
      mockAuditLogCreate.mockClear();

      await request(app)
        .get('/api/v1/admin/export')
        .set('x-api-key', 'test-admin-key');

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('does not crash request if audit log persistence fails', async () => {
      mockAuditLogCreate.mockRejectedValueOnce(new Error('Database connection failure'));
      mockUserUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockUserFindMany.mockResolvedValueOnce([{ username: 'bob' }]);

      const res = await request(app)
        .post('/api/v1/admin/block')
        .set('x-api-key', 'test-admin-key')
        .send({ address: 'GBOB1234567890123456789012345678901234567890123456789012' });

      expect(res.status).toBe(200);

      await new Promise((resolve) => setImmediate(resolve));
      expect(mockAuditLogCreate).toHaveBeenCalled();
    });

    it('createAuditLogMiddleware respects custom methods and custom prismaClient', async () => {
      const customPrisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
      const mw = createAuditLogMiddleware({ methods: ['DELETE'], prismaClient: customPrisma });
      const reqPost = { method: 'POST', originalUrl: '/test' };
      const reqDelete = {
        method: 'DELETE',
        originalUrl: '/test-delete',
        path: '/test-delete',
        headers: { 'x-user-id': 'custom-user' },
        body: {},
      };
      let deleteFinishCb;
      const resDelete = {
        statusCode: 200,
        on: jest.fn((event, cb) => {
          if (event === 'finish') deleteFinishCb = cb;
        }),
      };
      const nextPost = jest.fn();
      const nextDelete = jest.fn();

      mw(reqPost, {}, nextPost);
      expect(nextPost).toHaveBeenCalled();

      mw(reqDelete, resDelete, nextDelete);
      expect(nextDelete).toHaveBeenCalled();
      expect(resDelete.on).toHaveBeenCalledWith('finish', expect.any(Function));

      deleteFinishCb();
      await new Promise((resolve) => setImmediate(resolve));
      expect(customPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'DELETE /test-delete',
          method: 'DELETE',
          userId: 'custom-user',
        }),
      });
    });
  });

  describe('Audit integrity: canonicalization', () => {
    it('produces identical canonical output regardless of key ordering', () => {
      const a = { b: 2, a: 1, nested: { z: 'last', y: 'first' } };
      const b = { nested: { y: 'first', z: 'last' }, a: 1, b: 2 };
      expect(canonicalize(a)).toBe(canonicalize(b));
    });

    it('preserves array order while canonicalizing nested objects', () => {
      const a = { list: [{ b: 1, a: 2 }, { d: 4, c: 3 }] };
      const b = { list: [{ a: 2, b: 1 }, { c: 3, d: 4 }] };
      expect(canonicalize(a)).toBe(canonicalize(b));
      expect(canonicalize({ list: [1, 2] })).not.toBe(canonicalize({ list: [2, 1] }));
    });

    it('produces a stable keyed digest for equivalent events', () => {
      const key = 'test-integrity-key';
      const eventA = { action: 'POST /admin/block', userId: 'admin', payload: { b: 1, a: 2 } };
      const eventB = { payload: { a: 2, b: 1 }, userId: 'admin', action: 'POST /admin/block' };
      expect(computeDigest(eventA, key)).toBe(computeDigest(eventB, key));
    });

    it('produces different digests for different keys or different content', () => {
      const event = { action: 'POST /admin/block', userId: 'admin' };
      expect(computeDigest(event, 'key-1')).not.toBe(computeDigest(event, 'key-2'));
      expect(computeDigest(event, 'key-1')).not.toBe(
        computeDigest({ ...event, userId: 'other' }, 'key-1')
      );
    });
  });

  describe('Audit integrity: chain verification', () => {
    const key = 'chain-key';

    function buildChain(events) {
      const chain = new AuditIntegrityChain({ keys: [key] });
      return events.map((event) => chain.append(event));
    }

    it('verifies an untampered chain successfully', () => {
      const records = buildChain([
        { action: 'a', userId: 'u1' },
        { action: 'b', userId: 'u2' },
        { action: 'c', userId: 'u3' },
      ]);
      const result = verifyChain(records, { keys: [key] });
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeNull();
    });

    it('detects tampering when a record is modified', () => {
      const records = buildChain([
        { action: 'a', userId: 'u1' },
        { action: 'b', userId: 'u2' },
        { action: 'c', userId: 'u3' },
      ]);
      records[1] = { ...records[1], event: { ...records[1].event, userId: 'attacker' } };
      const result = verifyChain(records, { keys: [key] });
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });

    it('detects tampering when a record is deleted from the middle', () => {
      const records = buildChain([
        { action: 'a', userId: 'u1' },
        { action: 'b', userId: 'u2' },
        { action: 'c', userId: 'u3' },
      ]);
      const tampered = [records[0], records[2]];
      const result = verifyChain(tampered, { keys: [key] });
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });

    it('detects tampering when the head record is deleted', () => {
      const records = buildChain([
        { action: 'a', userId: 'u1' },
        { action: 'b', userId: 'u2' },
      ]);
      const result = verifyChain([records[1]], { keys: [key] });
      expect(result.valid).toBe(false);
    });
  });

  describe('Audit integrity: key rotation', () => {
    it('verifies records written under previous and current keys', () => {
      const oldKey = 'old-key';
      const newKey = 'new-key';

      const oldChain = new AuditIntegrityChain({ keys: [oldKey] });
      const r1 = oldChain.append({ action: 'a', userId: 'u1' });
      const r2 = oldChain.append({ action: 'b', userId: 'u2' });

      const rotatedChain = new AuditIntegrityChain({
        keys: [newKey, oldKey],
        previous: r2,
      });
      const r3 = rotatedChain.append({ action: 'c', userId: 'u3' });

      const result = verifyChain([r1, r2, r3], { keys: [newKey, oldKey] });
      expect(result.valid).toBe(true);
    });

    it('fails verification when the key used to sign is not available', () => {
      const chain = new AuditIntegrityChain({ keys: ['retired-key'] });
      const records = [chain.append({ action: 'a', userId: 'u1' })];
      const result = verifyChain(records, { keys: ['new-key'] });
      expect(result.valid).toBe(false);
    });
  });

  describe('Audit integrity: concurrent writes', () => {
    it('serializes concurrent appends into a valid chain', async () => {
      const key = 'concurrent-key';
      const chain = new AuditIntegrityChain({ keys: [key] });

      const records = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          chain.append({ action: `action-${i}`, userId: `u-${i}` })
        )
      );

      expect(records).toHaveLength(25);
      const result = verifyChain(records, { keys: [key] });
      expect(result.valid).toBe(true);
      // Sequence numbers must be unique and contiguous.
      const seqs = records.map((r) => r.sequence).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
    });
  });

  describe('GET /admin/audit-logs', () => {
    it('returns 401 without API key', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs');
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong API key', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('x-api-key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('returns list of audit logs with valid API key', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          action: 'POST /admin/block',
          method: 'POST',
          path: '/api/v1/admin/block',
          userId: 'admin',
          ipAddress: '127.0.0.1',
          statusCode: 200,
          createdAt: new Date(),
        },
      ];
      mockAuditLogFindMany.mockResolvedValueOnce(mockLogs);

      const res = await request(app)
        .get('/api/v1/admin/audit-logs?limit=10')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        count: 1,
        data: expect.any(Array),
      });
      expect(mockAuditLogFindMany).toHaveBeenCalledWith({
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
    });

    it('clamps ?limit=10000 to at most 100 rows (schema cap)', async () => {
      // The schema enforces max(100) via clampedInt, so even if the caller
      // sends limit=10000 the handler must pass take=100 to the database.
      mockAuditLogFindMany.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/api/v1/admin/audit-logs?limit=10000')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      // Confirm the DB was called with take capped at 100, not 10000.
      expect(mockAuditLogFindMany).toHaveBeenCalledWith({
        take: 100,
        orderBy: { createdAt: 'desc' },
      });
    });

    it('uses default limit of 50 when no limit param is supplied', async () => {
      mockAuditLogFindMany.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(mockAuditLogFindMany).toHaveBeenCalledWith({
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
