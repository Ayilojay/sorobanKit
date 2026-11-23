'use strict';

const express = require('express');
const request = require('supertest');

const mockValidateApiKey = jest.fn();
jest.mock('../../src/services/apiKeyService', () => ({
  hashKey: jest.fn(),
  safeCompareHash: jest.fn(),
  validateApiKey: (...args) => mockValidateApiKey(...args),
}));

const {
  apiKeyAuthentication,
  apiKeyScopeMiddleware,
  requiredScopeForRequest,
} = require('../../src/middleware/apiKeyAuth');
const { buildErrorHandler } = require('../../src/middleware/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(apiKeyAuthentication);
  app.use(apiKeyScopeMiddleware);
  app.get('/api/v1/federation', (_req, res) => res.json({ ok: true }));
  app.post('/api/v1/register', (_req, res) => res.json({ ok: true }));
  app.get('/api/v1/admin/stats', (_req, res) => res.json({ ok: true }));
  app.options('/api/v1/register', (_req, res) => res.sendStatus(204));
  app.use(buildErrorHandler(() => false));
  return app;
};

describe('API key scope policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_API_KEY;
  });

  test.each([
    ['GET', '/api/v1/federation', 'read'],
    ['POST', '/register', 'write'],
    ['GET', '/api/admin/stats', 'admin'],
    ['OPTIONS', '/api/v1/register', null],
  ])('requires %s scope for %s', (method, path, scope) => {
    expect(requiredScopeForRequest({ method, path })).toBe(scope);
  });

  test('allows a valid read key on a read route', async () => {
    mockValidateApiKey.mockResolvedValue({ id: 'key-1', scopes: ['read'] });

    const res = await request(buildApp())
      .get('/api/v1/federation')
      .set('X-Api-Key', 'read-key');

    expect(res.status).toBe(200);
    expect(mockValidateApiKey).toHaveBeenCalledWith('read-key');
  });

  test('rejects a valid key with insufficient scope as forbidden', async () => {
    mockValidateApiKey.mockResolvedValue({ id: 'key-1', scopes: ['read'] });

    const res = await request(buildApp())
      .post('/api/v1/register')
      .set('X-Api-Key', 'read-key');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'FORBIDDEN',
        retryable: false,
        details: [{ field: 'scopes', message: 'This endpoint requires the write scope.' }],
      },
    });
  });

  test('requires admin scope for administrative routes', async () => {
    mockValidateApiKey.mockResolvedValue({ id: 'key-1', scopes: ['read', 'write'] });

    const res = await request(buildApp())
      .get('/api/v1/admin/stats')
      .set('X-Api-Key', 'read-write-key');

    expect(res.status).toBe(403);
    expect(res.body.error.details[0].message).toContain('admin scope');
  });

  test('rejects invalid credentials instead of treating them as anonymous', async () => {
    mockValidateApiKey.mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/v1/federation')
      .set('X-Api-Key', 'invalid-key');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.retryable).toBe(false);
  });

  test('returns a retryable service error when credential storage fails', async () => {
    mockValidateApiKey.mockRejectedValue(new Error('database connection secret'));

    const res = await request(buildApp())
      .get('/api/v1/federation')
      .set('X-Api-Key', 'read-key');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'API key authentication is unavailable',
      retryable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('database connection secret');
    expect(res.body.reference_id).toEqual(expect.any(String));
  });

  test('allows unauthenticated public access and CORS preflight', async () => {
    mockValidateApiKey.mockResolvedValue(null);

    const app = buildApp();
    const publicResponse = await request(app).get('/api/v1/federation');
    const preflightResponse = await request(app).options('/api/v1/register');

    expect(publicResponse.status).toBe(200);
    expect(preflightResponse.status).toBe(204);
    expect(mockValidateApiKey).not.toHaveBeenCalled();
  });

  test('rejects a revoked key immediately', async () => {
    mockValidateApiKey.mockResolvedValue({
      id: 'key-1',
      scopes: ['read'],
      revokedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    const res = await request(buildApp())
      .get('/api/v1/federation')
      .set('X-Api-Key', 'revoked-key');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.retryable).toBe(false);
  });

  test('rejects a predecessor key once the overlap window has expired', async () => {
    mockValidateApiKey.mockResolvedValue({
      id: 'key-1',
      scopes: ['read'],
      overlapExpiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(buildApp())
      .get('/api/v1/federation')
      .set('X-Api-Key', 'expired-key');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('accepts a predecessor key while the overlap window is open', async () => {
    mockValidateApiKey.mockResolvedValue({
      id: 'key-1',
      scopes: ['read'],
      overlapExpiresAt: new Date(Date.now() + 60_000),
      successorKeyId: 'key-2',
    });

    const res = await request(buildApp())
      .get('/api/v1/federation')
      .set('X-Api-Key', 'rotating-key');

    expect(res.status).toBe(200);
  });

  test('attaches lineage metadata to the authenticated request', async () => {
    mockValidateApiKey.mockResolvedValue({
      id: 'key-2',
      scopes: ['read'],
      predecessorKeyId: 'key-1',
      successorKeyId: null,
      overlapExpiresAt: new Date(Date.now() + 60_000),
    });

    let observed;
    const app = express();
    app.use(apiKeyAuthentication);
    app.get('/api/v1/federation', (req, res) => {
      observed = req.apiKey;
      res.json({ ok: true });
    });
    app.use(buildErrorHandler(() => false));

    const res = await request(app)
      .get('/api/v1/federation')
      .set('X-Api-Key', 'successor-key');

    expect(res.status).toBe(200);
    expect(observed).toMatchObject({
      id: 'key-2',
      predecessorKeyId: 'key-1',
      successorKeyId: null,
    });
  });

  test('falls back to the legacy ADMIN_API_KEY when no key is stored', async () => {
    process.env.ADMIN_API_KEY = 'legacy-admin-secret';
    mockValidateApiKey.mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/v1/admin/stats')
      .set('X-Api-Key', 'legacy-admin-secret');

    expect(res.status).toBe(200);
  });

  test('rejects an incorrect legacy ADMIN_API_KEY', async () => {
    process.env.ADMIN_API_KEY = 'legacy-admin-secret';
    mockValidateApiKey.mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/v1/admin/stats')
      .set('X-Api-Key', 'wrong-secret');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
