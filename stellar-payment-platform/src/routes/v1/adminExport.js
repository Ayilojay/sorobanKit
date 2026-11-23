'use strict';

const { once } = require('events');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { ApiError } = require('../../errors');
const { adminExportQuerySchema } = require('../../schemas');
const { logger } = require('../../logger');
const { adminExportJobs } = require('../../services/adminExportJobs');

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

const parseExportFilters = (query, next) => {
  const parsed = adminExportQuerySchema.shape.limit.safeParse(query.limit);
  if (!parsed.success) {
    next(new ApiError('INVALID_INPUT', 'limit must be a positive integer'));
    return null;
  }

  let rowLimit;
  try {
    rowLimit = exportRowLimit(parsed.data);
  } catch (error) {
    next(new ApiError('INTERNAL_ERROR', 'Admin export configuration is invalid', {
      cause: error,
      retryable: false,
    }));
    return null;
  }

  const { format = 'csv', startDate, endDate } = query;
  if (format !== 'csv' && format !== 'json') {
    next(new ApiError('INVALID_INPUT', 'format must be csv or json'));
    return null;
  }

  let dateFilter;
  if (startDate || endDate) {
    const gte = startDate ? new Date(startDate) : undefined;
    const lte = endDate ? new Date(endDate) : undefined;
    if (gte && isNaN(gte.getTime())) {
      next(new ApiError('INVALID_INPUT', 'Invalid startDate'));
      return null;
    }
    if (lte && isNaN(lte.getTime())) {
      next(new ApiError('INVALID_INPUT', 'Invalid endDate'));
      return null;
    }
    if (gte && lte && gte > lte) {
      next(new ApiError('INVALID_INPUT', 'startDate must not be after endDate'));
      return null;
    }
    dateFilter = {};
    if (gte) dateFilter.gte = gte;
    if (lte) dateFilter.lte = lte;
  }

  return { rowLimit, format, dateFilter };
};

const auditExport = (req, action, details) => {
  logger.info('[Audit] admin export', {
    action,
    actorId: req.admin?.id ?? req.adminId ?? null,
    correlationId: req.correlationId,
    ...details,
  });
};

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
