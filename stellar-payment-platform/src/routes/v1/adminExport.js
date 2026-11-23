'use strict';

const { once } = require('events');
const crypto = require('crypto');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { ApiError } = require('../../errors');
const { adminExportQuerySchema } = require('../../schemas');
const { logger } = require('../../logger');
const { adminExportJobs } = require('../../services/adminExportJobs');

const STEP_UP_ACTION = 'admin.export';
const STEP_UP_HEADER = 'x-step-up-token';
const STEP_UP_TTL_MS = 5 * 60 * 1000;
const STEP_UP_MAX_ATTEMPTS = 5;

// In-memory single-use challenge store. Challenges are bound to the action and
// payload hash and expire after STEP_UP_TTL_MS. A production deployment should
// back this with a shared, transactional store; the interface is intentionally
// small so it can be swapped without touching route logic.
const stepUpChallenges = new Map();

const pruneExpiredChallenges = (now = Date.now()) => {
  for (const [id, challenge] of stepUpChallenges) {
    if (challenge.expiresAt <= now) stepUpChallenges.delete(id);
  }
};

const hashPayload = (payload) =>
  crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

const normalizeExportPayload = ({ format, startDate, endDate, limit }) => ({
  format: format ?? 'csv',
  startDate: startDate ? new Date(startDate).toISOString() : null,
  endDate: endDate ? new Date(endDate).toISOString() : null,
  limit: limit ?? null,
});

const issueStepUpChallenge = ({ action, payloadHash, ttlMs = STEP_UP_TTL_MS, now = Date.now() }) => {
  pruneExpiredChallenges(now);
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  stepUpChallenges.set(id, {
    id,
    action,
    payloadHash,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: now + ttlMs,
    attempts: 0,
    consumed: false,
  });
  return { id, token, expiresAt: now + ttlMs };
};

const consumeStepUpChallenge = ({ id, token, action, payloadHash, now = Date.now() }) => {
  pruneExpiredChallenges(now);
  const challenge = id ? stepUpChallenges.get(id) : undefined;
  if (!challenge) return { ok: false, reason: 'STEP_UP_REQUIRED' };
  if (challenge.consumed) return { ok: false, reason: 'STEP_UP_ALREADY_USED' };
  if (challenge.expiresAt <= now) {
    stepUpChallenges.delete(id);
    return { ok: false, reason: 'STEP_UP_EXPIRED' };
  }
  if (challenge.action !== action || challenge.payloadHash !== payloadHash) {
    return { ok: false, reason: 'STEP_UP_MISMATCH' };
  }
  challenge.attempts += 1;
  const provided = crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
  const expected = Buffer.from(challenge.tokenHash, 'hex');
  const actual = Buffer.from(provided, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    if (challenge.attempts >= STEP_UP_MAX_ATTEMPTS) {
      stepUpChallenges.delete(id);
      return { ok: false, reason: 'STEP_UP_ATTEMPTS_EXCEEDED' };
    }
    return { ok: false, reason: 'STEP_UP_INVALID' };
  }
  // Single use: consume before returning success.
  challenge.consumed = true;
  stepUpChallenges.delete(id);
  return { ok: true, challengeId: id };
};

const recordStepUpAudit = (req, { challengeId, payloadHash, outcome, reason }) => {
  logger.info('[step-up] administrative action audit', {
    correlationId: req.correlationId,
    action: STEP_UP_ACTION,
    challengeId: challengeId ?? null,
    payloadHash,
    outcome,
    reason: reason ?? null,
    actor: req.admin?.id ?? req.adminId ?? null,
    at: new Date().toISOString(),
  });
};

const PAGE_SIZE = 500;
const DEFAULT_MAX_ROWS = 1000000;

const exportRowLimit = (limit) => {
  const value = process.env.ADMIN_EXPORT_MAX_ROWS;
  const cap = value === undefined ? DEFAULT_MAX_ROWS : Number(value);
  if ((value !== undefined && !/^[0-9]+$/.test(value)) ||
      !Number.isInteger(cap) || cap < 1 || cap > 2147483647) {
    throw new Error('ADMIN_EXPORT_MAX_ROWS must be a positive 32-bit integer');
  }
  return Math.min(limit ?? cap, cap);
};

const writeChunk = async (res, chunk) => {
  if (!res.write(chunk)) await once(res, 'drain');
};

const csvRow = (record) => Object.values(record).map((value) => {
  if (value === null || value === undefined) return '';
  const text = String(value instanceof Date ? value.toISOString() : value);
  return /[,"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}).join(',') + '\n';

// Convert an exact integer amount (BigInt or numeric string) at the given asset
// precision into a plain decimal string. Trailing fractional zeros are trimmed so
// the output stays byte-compatible with the previous Float serialization.
const unitsToDecimalString = (units, precision) => {
  if (units === null || units === undefined) return null;
  const value = typeof units === 'bigint' ? units : BigInt(String(units));
  const p = Number(precision ?? 0);
  if (!Number.isInteger(p) || p < 0) throw new Error('Invalid asset precision');
  if (p === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = abs.toString().padStart(p + 1, '0');
  const whole = digits.slice(0, digits.length - p);
  const fraction = digits.slice(digits.length - p).replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${text}` : text;
};

const EXPORT_SELECT = {
  id: true,
  createdAt: true,
  amountUnits: true,
  feeUnits: true,
  assetPrecision: true,
};

const serializeExportRecord = (record) => ({
  ...record,
  amount: unitsToDecimalString(record.amountUnits, record.assetPrecision),
  fee: unitsToDecimalString(record.feeUnits, record.assetPrecision),
  amountUnits: record.amountUnits === null || record.amountUnits === undefined
    ? null
    : String(record.amountUnits),
  feeUnits: record.feeUnits === null || record.feeUnits === undefined
    ? null
    : String(record.feeUnits),
});

const jsonRow = (record) => JSON.stringify(record, (_key, value) =>
  typeof value === 'bigint' ? value.toString() : value) + '\n';

/**
 * @openapi
 * /admin/export:
 *   get:
 *     tags: [v1]
 *     deprecated: true
 *     description: >
 *       Deprecated synchronous streaming export for small exports. Prefer
 *       POST /admin/export/jobs for large exports; it runs as a cancellable
 *       background job with an expiring download artifact.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1 }
 *         description: Optional row limit; ADMIN_EXPORT_MAX_ROWS always applies.
 *     responses:
 *       200:
 *         description: CSV or NDJSON export
 *         headers:
 *           X-Truncated:
 *             schema: { type: boolean }
 *             description: True when additional matching rows were omitted.
 *           Deprecation:
 *             schema: { type: string }
 *             description: Present to signal this endpoint is deprecated.
 *
 * /admin/export/jobs:
 *   post:
 *     tags: [v1]
 *     description: Create a cancellable background export job.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               limit: { type: integer, minimum: 1 }
 *               format: { type: string, enum: [csv, json] }
 *               startDate: { type: string, format: date-time }
 *               endDate: { type: string, format: date-time }
 *     responses:
 *       202:
 *         description: Job accepted
 *       400:
 *         description: Invalid input
 *
 * /admin/export/jobs/{id}:
 *   get:
 *     tags: [v1]
 *     description: Get export job status and progress. Only the owning admin may read it.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job status
 *       404:
 *         description: Job not found or not owned by caller
 *
 * /admin/export/jobs/{id}/cancel:
 *   post:
 *     tags: [v1]
 *     description: Cancel a pending or running export job. Only the owner may cancel.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job cancelled or already terminal
 *       404:
 *         description: Job not found or not owned by caller
 *
 * /admin/export/jobs/{id}/download:
 *   get:
 *     tags: [v1]
 *     description: Download the completed export artifact. Only the owner may download.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Export artifact
 *       404:
 *         description: Job not found or not owned by caller
 *       409:
 *         description: Job has not completed
 *       410:
 *         description: Artifact expired
 */
module.exports = (router, adminAuth, getPrisma) => {
  const jobs = adminExportJobs(getPrisma);

  router.get('/admin/export', adminAuth, asyncHandler(async (req, res, next) => {
    const filters = parseExportFilters(req.query, next);
    if (!filters) return undefined;
    const { rowLimit, format, dateFilter } = filters;

    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</admin/export/jobs>; rel="successor-version"');
    auditExport(req, 'export.stream', { rowLimit, format });

    // Step-up verification: bind a single-use challenge to the action and the
    // normalized payload hash so a token cannot be replayed for a different export.
    const payloadHash = hashPayload(normalizeExportPayload({
      format, startDate, endDate, limit: parsed.data ?? null,
    }));
    const stepUpId = req.get(STEP_UP_HEADER) || req.body?.stepUpId;
    const stepUpToken = req.get('x-step-up-token-secret') || req.body?.stepUpToken;
    const stepUp = consumeStepUpChallenge({
      id: stepUpId,
      token: stepUpToken,
      action: STEP_UP_ACTION,
      payloadHash,
    });
    if (!stepUp.ok) {
      recordStepUpAudit(req, {
        challengeId: stepUpId,
        payloadHash,
        outcome: 'denied',
        reason: stepUp.reason,
      });
      return next(new ApiError('STEP_UP_REQUIRED', 'A valid single-use step-up verification is required', {
        details: { reason: stepUp.reason, action: STEP_UP_ACTION, payloadHash },
        retryable: false,
      }));
    }
    recordStepUpAudit(req, {
      challengeId: stepUp.challengeId,
      payloadHash,
      outcome: 'granted',
    });

    const { prisma } = getPrisma();
    const where = dateFilter ? { createdAt: dateFilter } : {};
    const orderBy = [{ createdAt: 'asc' }, { id: 'asc' }];
    // Probe one row beyond the boundary before the first write commits headers.
    const overflow = await prisma.payment.findMany({
      where, orderBy, skip: rowLimit, take: 1, select: { id: true },
    });
    if (overflow.length > 0) res.setHeader('X-Truncated', 'true');

    const isJson = format === 'json';
    const ext = isJson ? 'ndjson' : 'csv';
    const filename = `admin-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
    res.status(200);
    res.setHeader('Content-Type', isJson ? 'application/x-ndjson' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    let total = 0;
    let cursor;
    let headerWritten = false;
    try {
      while (total < rowLimit && !res.writableEnded && !res.destroyed) {
        const take = Math.min(PAGE_SIZE, rowLimit - total);
        const records = await prisma.payment.findMany({
          where, orderBy, take, select: EXPORT_SELECT,
          ...(cursor ? { cursor, skip: 1 } : { skip: 0 }),
        });
        if (records.length === 0) break;
        for (const record of records) {
          if (res.destroyed || res.writableEnded) return;
          const serialized = serializeExportRecord(record);
          if (!isJson && !headerWritten) {
            await writeChunk(res, Object.keys(serialized).map((field) => `"${field}"`).join(',') + '\n');
            headerWritten = true;
          }
          await writeChunk(res, isJson ? jsonRow(serialized) : csvRow(serialized));
          total += 1;
        }
        if (records.length < take) break;
        cursor = { id: records[records.length - 1].id };
      }
      return res.end();
    } catch (error) {
      recordStepUpAudit(req, {
        challengeId: stepUp.challengeId,
        payloadHash,
        outcome: 'failed',
        reason: 'EXPORT_ERROR',
      });
      logger.error(`[Correlation ID: ${req.correlationId}] Admin export failed`, error);
      return res.destroy(error);
    }
  }));

  router.post('/admin/export/jobs', adminAuth, asyncHandler(async (req, res, next) => {
    const filters = parseExportFilters(req.body ?? {}, next);
    if (!filters) return undefined;

    const job = await jobs.create({
      ownerId: req.admin?.id ?? req.adminId,
      rowLimit: filters.rowLimit,
      format: filters.format,
      dateFilter: filters.dateFilter,
      correlationId: req.correlationId,
    });
    auditExport(req, 'export.job.create', { jobId: job.id, rowLimit: filters.rowLimit, format: filters.format });
    return res.status(202).json({ data: jobs.serialize(job) });
  }));

  router.get('/admin/export/jobs/:id', adminAuth, asyncHandler(async (req, res, next) => {
    const job = await jobs.getOwned(req.params.id, req.admin?.id ?? req.adminId);
    if (!job) return next(new ApiError('NOT_FOUND', 'Export job not found'));
    auditExport(req, 'export.job.status', { jobId: job.id, status: job.status });
    return res.status(200).json({ data: jobs.serialize(job) });
  }));

  router.post('/admin/export/jobs/:id/cancel', adminAuth, asyncHandler(async (req, res, next) => {
    const job = await jobs.cancel(req.params.id, req.admin?.id ?? req.adminId);
    if (!job) return next(new ApiError('NOT_FOUND', 'Export job not found'));
    auditExport(req, 'export.job.cancel', { jobId: job.id, status: job.status });
    return res.status(200).json({ data: jobs.serialize(job) });
  }));

  router.get('/admin/export/jobs/:id/download', adminAuth, asyncHandler(async (req, res, next) => {
    const job = await jobs.getOwned(req.params.id, req.admin?.id ?? req.adminId);
    if (!job) return next(new ApiError('NOT_FOUND', 'Export job not found'));
    if (job.status !== 'completed') {
      return next(new ApiError('CONFLICT', 'Export job has not completed'));
    }
    if (jobs.isExpired(job)) {
      auditExport(req, 'export.job.download.expired', { jobId: job.id });
      return next(new ApiError('GONE', 'Export artifact has expired'));
    }

    const ext = job.format === 'json' ? 'ndjson' : 'csv';
    res.status(200);
    res.setHeader('Content-Type', job.format === 'json' ? 'application/x-ndjson' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="admin-export-${job.id}.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');
    auditExport(req, 'export.job.download', { jobId: job.id });

    try {
      await jobs.streamArtifact(job, res);
      return res.end();
    } catch (error) {
      logger.error(`[Correlation ID: ${req.correlationId}] Admin export download failed`, error);
      return res.destroy(error);
    }
  }));
};

module.exports.STEP_UP_ACTION = STEP_UP_ACTION;
module.exports.STEP_UP_HEADER = STEP_UP_HEADER;
module.exports.STEP_UP_TTL_MS = STEP_UP_TTL_MS;
module.exports.hashPayload = hashPayload;
module.exports.normalizeExportPayload = normalizeExportPayload;
module.exports.issueStepUpChallenge = issueStepUpChallenge;
module.exports.consumeStepUpChallenge = consumeStepUpChallenge;
module.exports._resetStepUpChallenges = () => stepUpChallenges.clear();
