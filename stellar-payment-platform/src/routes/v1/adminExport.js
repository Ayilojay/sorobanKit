'use strict';

const { once } = require('events');
const crypto = require('crypto');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { ApiError } = require('../../errors');
const { adminExportQuerySchema } = require('../../schemas');
const { logger } = require('../../logger');

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

/**
 * @openapi
 * /admin/export:
 *   get:
 *     tags: [v1]
 *     description: Stream transactions up to the requested limit and server cap.
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
 */
module.exports = (router, adminAuth, getPrisma) => {
  router.get('/admin/export', adminAuth, asyncHandler(async (req, res, next) => {
    const parsed = adminExportQuerySchema.shape.limit.safeParse(req.query.limit);
    if (!parsed.success) return next(new ApiError('INVALID_INPUT', 'limit must be a positive integer'));

    let rowLimit;
    try {
      rowLimit = exportRowLimit(parsed.data);
    } catch (error) {
      return next(new ApiError('INTERNAL_ERROR', 'Admin export configuration is invalid', {
        cause: error,
        retryable: false,
      }));
    }

    const { format = 'csv', startDate, endDate } = req.query;
    let dateFilter;
    if (startDate || endDate) {
      const gte = startDate ? new Date(startDate) : undefined;
      const lte = endDate ? new Date(endDate) : undefined;
      if (gte && isNaN(gte.getTime())) return next(new ApiError('INVALID_INPUT', 'Invalid startDate'));
      if (lte && isNaN(lte.getTime())) return next(new ApiError('INVALID_INPUT', 'Invalid endDate'));
      if (gte && lte && gte > lte) return next(new ApiError('INVALID_INPUT', 'startDate must not be after endDate'));
      dateFilter = {};
      if (gte) dateFilter.gte = gte;
      if (lte) dateFilter.lte = lte;
    }

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
          where, orderBy, take, ...(cursor ? { cursor, skip: 1 } : { skip: 0 }),
        });
        if (records.length === 0) break;
        for (const record of records) {
          if (res.destroyed || res.writableEnded) return;
          if (!isJson && !headerWritten) {
            await writeChunk(res, Object.keys(record).map((field) => `"${field}"`).join(',') + '\n');
            headerWritten = true;
          }
          await writeChunk(res, isJson ? JSON.stringify(record) + '\n' : csvRow(record));
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

  // Issues a short-lived, single-use step-up challenge bound to the export payload.
  router.post('/admin/export/step-up', adminAuth, asyncHandler(async (req, res, next) => {
    const { format, startDate, endDate, limit } = req.body ?? {};
    const normalized = normalizeExportPayload({ format, startDate, endDate, limit });
    const payloadHash = hashPayload(normalized);
    const challenge = issueStepUpChallenge({ action: STEP_UP_ACTION, payloadHash });
    recordStepUpAudit(req, {
      challengeId: challenge.id,
      payloadHash,
      outcome: 'issued',
    });
    return res.status(201).json({
      challengeId: challenge.id,
      token: challenge.token,
      action: STEP_UP_ACTION,
      payloadHash,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    });
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
