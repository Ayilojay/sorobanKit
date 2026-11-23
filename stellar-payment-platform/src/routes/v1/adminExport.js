'use strict';

const { once } = require('events');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { ApiError } = require('../../errors');
const { adminExportQuerySchema } = require('../../schemas');
const { logger } = require('../../logger');

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
      logger.error(`[Correlation ID: ${req.correlationId}] Admin export failed`, error);
      return res.destroy(error);
    }
  }));
};
