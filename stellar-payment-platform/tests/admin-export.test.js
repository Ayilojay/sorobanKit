'use strict';

/**
 * tests/admin-export.test.js
 *
 * Tests for GET /admin/export (issue #489).
 */

const request = require('supertest');

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockFindMany = jest.fn();
const mockExportJobCreate = jest.fn();
const mockExportJobFindUnique = jest.fn();
const mockExportJobFindFirst = jest.fn();
const mockExportJobUpdate = jest.fn();
const mockExportJobFindMany = jest.fn();
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findMany: (query) => query.select ? Promise.resolve([]) : mockFindMany(query),
    },
    exportJob: {
      create: (...args) => mockExportJobCreate(...args),
      findUnique: (...args) => mockExportJobFindUnique(...args),
      findFirst: (...args) => mockExportJobFindFirst(...args),
      findMany: (...args) => mockExportJobFindMany(...args),
      update: (...args) => mockExportJobUpdate(...args),
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

// Mock the background export job service so tests can drive job state directly.
const mockExportJobService = {
  createExportJob: jest.fn(),
  getExportJob: jest.fn(),
  cancelExportJob: jest.fn(),
  getDownloadArtifact: jest.fn(),
  runExportJob: jest.fn(),
};
jest.mock('../src/export-job-service', () => mockExportJobService);

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

// Load app after mocks are in place.
const { app } = require('../server');

// ── helpers ──────────────────────────────────────────────────────────────────

const makeRecord = (i) => ({
  id: `txn-${i}`,
  createdAt: new Date('2026-01-15T12:00:00Z'),
  fromAddress: `GSENDER${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  toAddress: `GRECIPIENT${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  amount: String(i * 100),
  assetCode: 'XLM',
  transactionHash: `hash${i}`,
  status: 'completed',
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('GET /admin/export', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockIssueStepUpChallenge.mockReset();
    mockConsumeStepUpChallenge.mockReset();
    mockRecordStepUpAudit.mockReset();
    mockRecordStepUpAudit.mockResolvedValue(undefined);
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/admin/export');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('streams CSV with correct headers (default format)', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1), makeRecord(2)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/\.csv/);
    // Header row present — json2csv quotes field names by default
    expect(res.text).toMatch(/"id"/);
    expect(res.text).toMatch(/"createdAt"/);
    // Data rows present
    expect(res.text).toMatch(/txn-1/);
    expect(res.text).toMatch(/txn-2/);
  });

  it('streams JSON with correct headers when format=json', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['content-disposition']).toMatch(/\.ndjson/);
    // Each line is valid JSON
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe('txn-1');
  });

  it('accepts explicit format=csv', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=csv')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('returns empty CSV (headers only) when no records found', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    // No data rows — response may be empty or contain only a newline
    expect(res.text.trim()).toBe('');
  });

  it('returns empty NDJSON when no records found with format=json', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe('');
  });

  it('passes startDate and endDate as date filters', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    await request(app)
      .get('/api/v1/admin/export?startDate=2026-01-01&endDate=2026-01-31')
      .set('x-api-key', 'test-admin-key');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it('rejects startDate after endDate with 400', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export?startDate=2026-02-01&endDate=2026-01-01')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(400);
  });

  it('rejects future startDate after past endDate with 400 and INVALID_INPUT', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export?startDate=2099-01-01&endDate=2000-01-01')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('rejects endDate before 1970-01-01 with 400 and INVALID_INPUT', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export?endDate=1969-12-31')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('rejects startDate after 2100-01-01 with 400 and INVALID_INPUT', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export?startDate=2100-01-02')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('streams all records from startDate forward when no endDate is given', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?startDate=2025-01-01')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/txn-1/);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: new Date('2025-01-01'),
          }),
        }),
      }),
    );
    const firstWhere = mockFindMany.mock.calls[0][0].where.createdAt;
    expect(firstWhere.lte).toBeUndefined();
  });

  it('streams records for a valid date range', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?startDate=2026-01-01&endDate=2026-01-31')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/txn-1/);
    const firstWhere = mockFindMany.mock.calls[0][0].where.createdAt;
    expect(firstWhere.gte).toEqual(new Date('2026-01-01'));
    expect(firstWhere.lte).toEqual(new Date('2026-01-31'));
  });

  it('handles multiple pages correctly', async () => {
    // First page: 500 records; second page: 2 records; third page: empty.
    const page1 = Array.from({ length: 500 }, (_, i) => makeRecord(i));
    const page2 = [makeRecord(500), makeRecord(501)];
    mockFindMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(502);
  });
});

// ── background job flow ──────────────────────────────────────────────────────

const makeJob = (overrides = {}) => ({
  id: 'job-1',
  ownerId: 'admin',
  status: 'queued',
  format: 'csv',
  progress: 0,
  totalRecords: null,
  processedRecords: 0,
  artifactPath: null,
  artifactExpiresAt: null,
  error: null,
  createdAt: new Date('2026-01-15T12:00:00Z'),
  updatedAt: new Date('2026-01-15T12:00:00Z'),
  ...overrides,
});

describe('POST /admin/export/jobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).post('/api/v1/admin/export/jobs').send({ format: 'csv' });
    expect(res.status).toBe(401);
    expect(mockExportJobService.createExportJob).not.toHaveBeenCalled();
  });

  it('creates a job and returns 202 with job id', async () => {
    mockExportJobService.createExportJob.mockResolvedValueOnce(makeJob());

    const res = await request(app)
      .post('/api/v1/admin/export/jobs')
      .set('x-api-key', 'test-admin-key')
      .send({ format: 'csv', startDate: '2026-01-01', endDate: '2026-01-31' });

    expect(res.status).toBe(202);
    expect(res.body.id).toBe('job-1');
    expect(res.body.status).toBe('queued');
    expect(res.headers.location).toMatch(/\/admin\/export\/jobs\/job-1/);
    expect(mockExportJobService.createExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: expect.any(String),
        format: 'csv',
        startDate: expect.any(Date),
        endDate: expect.any(Date),
      }),
    );
  });

  it('rejects invalid format with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/export/jobs')
      .set('x-api-key', 'test-admin-key')
      .send({ format: 'xml' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(mockExportJobService.createExportJob).not.toHaveBeenCalled();
  });

  it('rejects startDate after endDate with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/export/jobs')
      .set('x-api-key', 'test-admin-key')
      .send({ format: 'csv', startDate: '2026-02-01', endDate: '2026-01-01' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(mockExportJobService.createExportJob).not.toHaveBeenCalled();
  });
});

describe('GET /admin/export/jobs/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/admin/export/jobs/job-1');
    expect(res.status).toBe(401);
  });

  it('returns job status and progress for the owner', async () => {
    mockExportJobService.getExportJob.mockResolvedValueOnce(
      makeJob({ status: 'running', progress: 42, processedRecords: 420, totalRecords: 1000 }),
    );

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/job-1')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('job-1');
    expect(res.body.status).toBe('running');
    expect(res.body.progress).toBe(42);
    expect(res.body.processedRecords).toBe(420);
    expect(res.body.totalRecords).toBe(1000);
  });

  it('returns 404 for an unknown job', async () => {
    mockExportJobService.getExportJob.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/missing')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 403 when the job belongs to another owner', async () => {
    mockExportJobService.getExportJob.mockResolvedValueOnce(
      makeJob({ ownerId: 'someone-else' }),
    );

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/job-1')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('POST /admin/export/jobs/:id/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).post('/api/v1/admin/export/jobs/job-1/cancel');
    expect(res.status).toBe(401);
  });

  it('cancels a queued job and returns the cancelled status', async () => {
    mockExportJobService.cancelExportJob.mockResolvedValueOnce(
      makeJob({ status: 'cancelled' }),
    );

    const res = await request(app)
      .post('/api/v1/admin/export/jobs/job-1/cancel')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(mockExportJobService.cancelExportJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', ownerId: expect.any(String) }),
    );
  });

  it('returns 409 when the job has already completed', async () => {
    const err = new Error('Job already finished');
    err.code = 'JOB_NOT_CANCELLABLE';
    mockExportJobService.cancelExportJob.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/api/v1/admin/export/jobs/job-1/cancel')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_NOT_CANCELLABLE');
  });

  it('returns 403 when cancelling another owner\'s job', async () => {
    const err = new Error('Forbidden');
    err.code = 'FORBIDDEN';
    mockExportJobService.cancelExportJob.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/api/v1/admin/export/jobs/job-1/cancel')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('GET /admin/export/jobs/:id/download', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/admin/export/jobs/job-1/download');
    expect(res.status).toBe(401);
  });

  it('streams the completed artifact for the owner', async () => {
    const { Readable } = require('stream');
    mockExportJobService.getDownloadArtifact.mockResolvedValueOnce({
      stream: Readable.from(['"id"\ntxn-1\n']),
      filename: 'export-job-1.csv',
      contentType: 'text/csv',
      size: 13,
    });

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/job-1/download')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/export-job-1\.csv/);
    expect(res.text).toMatch(/txn-1/);
  });

  it('returns 409 when the job is not yet complete', async () => {
    const err = new Error('Job not complete');
    err.code = 'JOB_NOT_COMPLETE';
    mockExportJobService.getDownloadArtifact.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/job-1/download')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_NOT_COMPLETE');
  });

  it('returns 410 when the artifact has expired', async () => {
    const err = new Error('Artifact expired');
    err.code = 'ARTIFACT_EXPIRED';
    mockExportJobService.getDownloadArtifact.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/job-1/download')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('ARTIFACT_EXPIRED');
  });

  it('returns 403 when downloading another owner\'s artifact', async () => {
    const err = new Error('Forbidden');
    err.code = 'FORBIDDEN';
    mockExportJobService.getDownloadArtifact.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/api/v1/admin/export/jobs/job-1/download')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
