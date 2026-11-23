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

const mockCreate = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockCount = jest.fn();
jest.mock('../prismaClient', () => ({
  prisma: {
    payment: { findMany: mockFindMany, count: mockCount },
    adminExportJob: { create: mockCreate, findUnique: mockFindUnique, update: mockUpdate },
  },
}));

const adminRoutes = require('../src/routes/v1/adminRoutes');
const app = express();
app.use('/api/v1', adminRoutes(null));
const originalCap = process.env.ADMIN_EXPORT_MAX_ROWS;
const originalKey = process.env.ADMIN_API_KEY;
const originalStepUpTtl = process.env.ADMIN_STEP_UP_TTL_MS;
let records;
let jobStore;

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
  jobStore = new Map();
  mockCreate.mockReset().mockImplementation(async ({ data }) => {
    const job = { id: `job-${jobStore.size + 1}`, status: 'queued', progress: 0, totalRows: null, ...data };
    jobStore.set(job.id, job);
    return job;
  });
  mockFindUnique.mockReset().mockImplementation(async ({ where }) => jobStore.get(where.id) || null);
  mockUpdate.mockReset().mockImplementation(async ({ where, data }) => {
    const job = { ...jobStore.get(where.id), ...data };
    jobStore.set(where.id, job);
    return job;
  });
  mockCount.mockReset().mockImplementation(async () => records.length);
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
const createJob = (query) => request(app).post(`/api/v1/admin/export/jobs?${query}`).set('x-api-key', 'test-export-key');
const getJob = (id) => request(app).get(`/api/v1/admin/export/jobs/${id}`).set('x-api-key', 'test-export-key');
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

it.each([undefined, '1000'])('applies the ADMIN_EXPORT_MAX_ROWS cap of 503 at job creation for requested limit %s', async (limit) => {
  process.env.ADMIN_EXPORT_MAX_ROWS = '503';
  const res = await createJob(`format=json${limit ? `&limit=${limit}` : ''}`);
  expect(res.status).toBe(202);
  expect(res.body).toEqual(expect.objectContaining({ id: expect.any(String), status: 'queued' }));
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ limit: 503, format: 'json' }),
  }));
  expect(mockFindMany).not.toHaveBeenCalled();
});

it('uses the default million-row cap at job creation when no limit or override is configured', async () => {
  const res = await createJob('format=json');
  expect(res.status).toBe(202);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ limit: 1000000 }),
  }));
});

it.each(['0', '-1', '1.5', 'abc', '', 'Infinity', '9007199254740992', '2&limit=3', '1e2'])('rejects invalid limit %s before enqueueing a job', async (limit) => {
  const res = await createJob(`limit=${limit}`);
  expect(res.status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockFindMany).not.toHaveBeenCalled();
});

it.each(['xml', 'CSVX', ''])('rejects invalid format %s before enqueueing a job', async (format) => {
  const res = await createJob(`format=${format}`);
  expect(res.status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockFindMany).not.toHaveBeenCalled();
});

it.each(['0', '-1', 'abc', '1.5', 'Infinity', '2147483648', ''])('fails closed for invalid cap %s at job creation', async (cap) => {
  process.env.ADMIN_EXPORT_MAX_ROWS = cap;
  const res = await createJob('format=json');
  expect(res.status).toBe(500);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockFindMany).not.toHaveBeenCalled();
});

it.each([500, 1000])('reports progress and totalRows correctly at a full %i-row page boundary', async (size) => {
  records = records.slice(0, size);
  const created = await createJob(`format=json&limit=${size}`);
  expect(created.status).toBe(202);
  const jobId = created.body.id;
  const res = await getJob(jobId);
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.objectContaining({
    id: jobId,
    totalRows: size,
    progress: 100,
    status: 'completed',
  }));
});

it('reports partial progress mid-export without exceeding totalRows', async () => {
  records = records.slice(0, 1000);
  const created = await createJob('format=json&limit=1000');
  const jobId = created.body.id;
  const res = await getJob(jobId);
  expect(res.status).toBe(200);
  expect(res.body.totalRows).toBe(1000);
  expect(res.body.progress).toBeGreaterThanOrEqual(0);
  expect(res.body.progress).toBeLessThanOrEqual(100);
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

it('rejects unknown jobs and jobs owned by another caller', async () => {
  const missing = await getJob('does-not-exist');
  expect(missing.status).toBe(404);
  jobStore.set('job-owned', { id: 'job-owned', status: 'queued', progress: 0, totalRows: null, ownerId: 'someone-else' });
  const forbidden = await getJob('job-owned');
  expect([403, 404]).toContain(forbidden.status);
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
