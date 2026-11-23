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
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

// ── step-up verification mock (issue #374) ───────────────────────────────────

const mockIssueStepUpChallenge = jest.fn();
const mockConsumeStepUpChallenge = jest.fn();
const mockRecordStepUpAudit = jest.fn();

jest.mock('../src/step-up-verification', () => ({
  STEP_UP_ACTIONS: {
    CONTRACT_UPGRADE: 'contract_upgrade',
    TREASURY_CHANGE: 'treasury_change',
    BULK_EXPORT: 'bulk_export',
  },
  issueStepUpChallenge: (...args) => mockIssueStepUpChallenge(...args),
  consumeStepUpChallenge: (...args) => mockConsumeStepUpChallenge(...args),
  recordStepUpAudit: (...args) => mockRecordStepUpAudit(...args),
  hashExportPayload: (query) => JSON.stringify(query),
}));

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

// ── step-up verification (issue #374) ────────────────────────────────────────

const STEP_UP_HEADER = 'x-step-up-token';

describe('GET /admin/export step-up verification', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockIssueStepUpChallenge.mockReset();
    mockConsumeStepUpChallenge.mockReset();
    mockRecordStepUpAudit.mockReset();
    mockRecordStepUpAudit.mockResolvedValue(undefined);
  });

  it('streams the export when a valid step-up challenge is presented', async () => {
    mockConsumeStepUpChallenge.mockResolvedValueOnce({ ok: true, challengeId: 'chal-1' });
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key')
      .set(STEP_UP_HEADER, 'step-up-token-1');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/txn-1/);
    expect(mockConsumeStepUpChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'step-up-token-1',
        action: 'bulk_export',
        payloadHash: expect.any(String),
      }),
    );
  });

  it('records audit evidence on successful export', async () => {
    mockConsumeStepUpChallenge.mockResolvedValueOnce({ ok: true, challengeId: 'chal-1' });
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key')
      .set(STEP_UP_HEADER, 'step-up-token-1');

    expect(mockRecordStepUpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bulk_export',
        outcome: 'success',
        challengeId: 'chal-1',
        payloadHash: expect.any(String),
      }),
    );
  });

  it('rejects the export with 401 when the step-up token is missing', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockRecordStepUpAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bulk_export', outcome: 'failure', reason: 'missing' }),
    );
  });

  it('rejects the export with 401 when the step-up token is expired', async () => {
    mockConsumeStepUpChallenge.mockResolvedValueOnce({ ok: false, reason: 'expired' });

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key')
      .set(STEP_UP_HEADER, 'expired-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_EXPIRED');
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockRecordStepUpAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bulk_export', outcome: 'failure', reason: 'expired' }),
    );
  });

  it('rejects the export with 401 when the step-up token was already used', async () => {
    mockConsumeStepUpChallenge.mockResolvedValueOnce({ ok: false, reason: 'reused' });

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key')
      .set(STEP_UP_HEADER, 'used-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_REUSED');
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockRecordStepUpAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bulk_export', outcome: 'failure', reason: 'reused' }),
    );
  });

  it('rejects the export with 409 when the payload hash does not match', async () => {
    mockConsumeStepUpChallenge.mockResolvedValueOnce({ ok: false, reason: 'payload_mismatch' });

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key')
      .set(STEP_UP_HEADER, 'token-for-other-payload');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STEP_UP_PAYLOAD_MISMATCH');
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockRecordStepUpAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bulk_export',
        outcome: 'failure',
        reason: 'payload_mismatch',
      }),
    );
  });

  it('allows only one of two concurrent requests to consume the same challenge', async () => {
    // First consumer wins; the second sees the challenge as already used.
    mockConsumeStepUpChallenge
      .mockResolvedValueOnce({ ok: true, challengeId: 'chal-race' })
      .mockResolvedValueOnce({ ok: false, reason: 'reused' });
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const [first, second] = await Promise.all([
      request(app)
        .get('/api/v1/admin/export')
        .set('x-api-key', 'test-admin-key')
        .set(STEP_UP_HEADER, 'race-token'),
      request(app)
        .get('/api/v1/admin/export')
        .set('x-api-key', 'test-admin-key')
        .set(STEP_UP_HEADER, 'race-token'),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 401]);
    const rejected = first.status === 401 ? first : second;
    expect(rejected.body.code).toBe('STEP_UP_REUSED');
    expect(mockRecordStepUpAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bulk_export', outcome: 'failure', reason: 'reused' }),
    );
  });
});
