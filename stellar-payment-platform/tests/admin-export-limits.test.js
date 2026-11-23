'use strict';

const express = require('express');
const request = require('supertest');
const mockFindMany = jest.fn();
jest.mock('../prismaClient', () => ({ prisma: { payment: { findMany: mockFindMany } } }));
jest.mock('../src/middleware/auditLog', () => ({ auditLogMiddleware: (req, res, next) => next() }));
jest.mock('../middleware/idempotency', () => ({ idempotencyMiddleware: () => (req, res, next) => next() }));
jest.mock('../src/webhookWorker', () => ({ listDLQEntries: jest.fn(), replayFromDLQ: jest.fn() }));
jest.mock('../src/services/activityService', () => ({ ACTIVITY_ACTIONS: {}, recordActivity: jest.fn() }));
jest.mock('../src/services/statsService', () => ({ getRoutingStats: jest.fn() }));
jest.mock('../src/federationCache', () => ({ invalidateFederationCache: jest.fn() }));
jest.mock('../src/cache/statsCache', () => ({}));

const adminRoutes = require('../src/routes/v1/adminRoutes');
const app = express();
app.use('/api/v1', adminRoutes(null));
const originalCap = process.env.ADMIN_EXPORT_MAX_ROWS;
const originalKey = process.env.ADMIN_API_KEY;
const originalStepUpTtl = process.env.ADMIN_STEP_UP_TTL_MS;
let records;

beforeEach(() => {
  process.env.ADMIN_API_KEY = 'test-export-key';
  delete process.env.ADMIN_EXPORT_MAX_ROWS;
  delete process.env.ADMIN_STEP_UP_TTL_MS;
  records = Array.from({ length: 1100 }, (_, id) => ({
    id: `txn-${id}`, createdAt: new Date('2026-01-15T12:00:00Z'), amount: `${id}`,
  }));
  mockFindMany.mockReset().mockImplementation(async ({ skip = 0, take, cursor, select }) => {
    const offset = cursor ? records.findIndex((record) => record.id === cursor.id) + skip : skip;
    const page = records.slice(offset, offset + take);
    return select ? page.map(({ id }) => ({ id })) : page;
  });
});

afterAll(() => {
  if (originalCap === undefined) delete process.env.ADMIN_EXPORT_MAX_ROWS;
  else process.env.ADMIN_EXPORT_MAX_ROWS = originalCap;
  if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalKey;
  if (originalStepUpTtl === undefined) delete process.env.ADMIN_STEP_UP_TTL_MS;
  else process.env.ADMIN_STEP_UP_TTL_MS = originalStepUpTtl;
});

const exportRows = (query) => request(app).get(`/api/v1/admin/export?${query}`).set('x-api-key', 'test-export-key');
const lines = (res) => res.text.trim().split('\n').filter(Boolean);

it.each(['csv', 'json'])('limits %s output to exactly 100 records and reports truncation', async (format) => {
  const res = await exportRows(`format=${format}&limit=100`);
  expect(res.status).toBe(200);
  expect(lines(res)).toHaveLength(format === 'csv' ? 101 : 100);
  expect(res.headers['x-truncated']).toBe('true');
});

it.each([undefined, '1000'])('enforces a hard cap of 503 with requested limit %s', async (limit) => {
  process.env.ADMIN_EXPORT_MAX_ROWS = '503';
  const res = await exportRows(`format=json${limit ? `&limit=${limit}` : ''}`);
  expect(res.status).toBe(200);
  expect(lines(res)).toHaveLength(503);
  expect(res.headers['x-truncated']).toBe('true');
  expect(lines(res).map((line) => JSON.parse(line).id)).toEqual(records.slice(0, 503).map(({ id }) => id));
  const batchQueries = mockFindMany.mock.calls.map(([query]) => query).filter(({ select }) => !select);
  expect(batchQueries.map(({ take }) => take)).toEqual([500, 3]);
});

it.each([0, 99, 100, 500, 501, 1000])('does not report truncation when all %i rows fit', async (size) => {
  records = records.slice(0, size);
  const res = await exportRows(`format=json&limit=${Math.max(size, 1)}`);
  expect(res.status).toBe(200);
  expect(lines(res)).toHaveLength(size);
  expect(res.headers['x-truncated']).toBeUndefined();
});

it.each([500, 1000])('reports truncation at a full %i-row batch boundary', async (limit) => {
  const res = await exportRows(`format=json&limit=${limit}`);
  expect(lines(res)).toHaveLength(limit);
  expect(res.headers['x-truncated']).toBe('true');
});

it('uses the default million-row cap when no limit or override is configured', async () => {
  records = [];
  const res = await exportRows('format=json');
  expect(res.status).toBe(200);
  expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 1000000, take: 1 }));
});

it.each(['0', '-1', '1.5', 'abc', '', 'Infinity', '9007199254740992', '2&limit=3', '1e2'])('rejects invalid limit %s before querying', async (limit) => {
  const res = await exportRows(`limit=${limit}`);
  expect(res.status).toBe(400);
  expect(mockFindMany).not.toHaveBeenCalled();
});

it.each(['0', '-1', 'abc', '1.5', 'Infinity', '2147483648', ''])('fails closed for invalid cap %s', async (cap) => {
  process.env.ADMIN_EXPORT_MAX_ROWS = cap;
  const res = await exportRows('format=json');
  expect(res.status).toBe(500);
  expect(mockFindMany).not.toHaveBeenCalled();
});

it('keeps the existing inclusive date filter on both the probe and stream', async () => {
  records = records.slice(0, 2);
  const res = await exportRows('format=json&limit=1&startDate=2026-01-01&endDate=2026-01-31');
  expect(res.status).toBe(200);
  for (const [query] of mockFindMany.mock.calls) {
    expect(query.where).toEqual({ createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') } });
  }
});

describe('admin export step-up verification', () => {
  const challenge = (query) => request(app)
    .post('/api/v1/admin/export/step-up')
    .set('x-api-key', 'test-export-key')
    .send({ query });
  const exportWithToken = (query, token) => request(app)
    .get(`/api/v1/admin/export?${query}`)
    .set('x-api-key', 'test-export-key')
    .set('x-step-up-token', token);

  it('issues a short-lived single-use token bound to the normalized query', async () => {
    const issued = await challenge('format=json&limit=100');
    expect(issued.status).toBe(200);
    expect(issued.body.token).toEqual(expect.any(String));
    expect(issued.body.expiresAt).toEqual(expect.any(String));

    const res = await exportWithToken('format=json&limit=100', issued.body.token);
    expect(res.status).toBe(200);
    expect(lines(res)).toHaveLength(100);

    const replay = await exportWithToken('format=json&limit=100', issued.body.token);
    expect(replay.status).toBe(403);
    expect(replay.body.error).toMatch(/step-up/i);
    expect(replay.text).not.toContain('txn-');
  });

  it('treats the payload hash as covering the normalized query, not raw ordering', async () => {
    const issued = await challenge('limit=100&format=json');
    const res = await exportWithToken('format=json&limit=100', issued.body.token);
    expect(res.status).toBe(200);
  });

  it('rejects a token whose payload hash does not match the requested export', async () => {
    const issued = await challenge('format=json&limit=100');
    const res = await exportWithToken('format=json&limit=101', issued.body.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/step-up/i);
    expect(res.text).not.toContain('txn-');
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('rejects a token at the exact expiry boundary and accepts just before it', async () => {
    process.env.ADMIN_STEP_UP_TTL_MS = '1000';
    const issued = await challenge('format=json&limit=10');
    const expiresAt = new Date(issued.body.expiresAt).getTime();

    jest.useFakeTimers({ now: expiresAt - 1 });
    try {
      const before = await exportWithToken('format=json&limit=10', issued.body.token);
      expect(before.status).toBe(200);
    } finally {
      jest.useRealTimers();
    }

    const second = await challenge('format=json&limit=10');
    jest.useFakeTimers({ now: new Date(second.body.expiresAt).getTime() });
    try {
      const atBoundary = await exportWithToken('format=json&limit=10', second.body.token);
      expect(atBoundary.status).toBe(403);
      expect(atBoundary.body.error).toMatch(/expired/i);
      expect(atBoundary.text).not.toContain('txn-');
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed for invalid TTL configuration without leaking rows', async () => {
    process.env.ADMIN_STEP_UP_TTL_MS = '0';
    const issued = await challenge('format=json&limit=10');
    expect(issued.status).toBe(500);
    expect(issued.text).not.toContain('txn-');
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('requires a step-up token for exports above the row-limit threshold', async () => {
    const res = await exportRows('format=json&limit=100');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/step-up/i);
    expect(res.text).not.toContain('txn-');
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
