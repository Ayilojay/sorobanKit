'use strict';

/**
 * src/utils/exporter.js
 *
 * Streams admin transaction records from the database to an HTTP response in
 * either CSV or JSON format.
 *
 * Design goals (issue #489):
 *  - Accept `format` (csv | json), optional `startDate` / `endDate` filters.
 *  - Stream records in pages so heap use is bounded regardless of export size.
 *  - Write JSON as a newline-delimited stream (one object per line) to avoid
 *    buffering the full array before the first byte is flushed.
 *  - Respect socket backpressure by awaiting drain when needed.
 */

const { once } = require('events');
const { Transform } = require('stream');
const { Parser: CsvParser } = require('json2csv');
const fs = require('fs');
const { pipeline } = require('stream/promises');

/** Number of rows fetched from the database per round-trip. */
const PAGE_SIZE = 500;

/** Maximum pages streamed in a single export request. */
const MAX_PAGES = Number(process.env.EXPORT_MAX_PAGES) || 200;

/**
 * Column names exported in the CSV/JSON response.
 * Mirrors the Prisma `payment` model fields relevant for accounting.
 */
const EXPORT_FIELDS = [
  'id',
  'createdAt',
  'fromAddress',
  'toAddress',
  'amount',
  'assetCode',
  'transactionHash',
  'status',
];

/**
 * Writes `chunk` to a writable sink, waiting for a drain event if the write
 * buffer is full (i.e. the sink is applying backpressure).  Works for both
 * HTTP responses and file streams.
 *
 * @param {import('stream').Writable} sink
 * @param {string|Buffer} chunk
 */
const writeChunk = async (sink, chunk) => {
  if (!sink.write(chunk)) {
    await once(sink, 'drain');
  }
};

/**
 * Returns true when the sink can no longer accept writes (HTTP response
 * ended/destroyed, or file stream closed).
 *
 * @param {import('stream').Writable} sink
 * @returns {boolean}
 */
const isSinkClosed = (sink) => Boolean(sink.writableEnded || sink.destroyed);

/**
 * Builds the Prisma `where` clause for the optional date-range filters.
 *
 * @param {string|undefined} startDate - ISO date string (inclusive lower bound).
 * @param {string|undefined} endDate   - ISO date string (inclusive upper bound).
 * @returns {object} Prisma where clause fragment.
 */
const buildDateFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return {};

  const filter = {};
  if (startDate) filter.gte = new Date(startDate);
  if (endDate) {
    // Include the whole end day by advancing to midnight of the next day.
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return { createdAt: filter };
};

/**
 * Streams admin transaction records to `res` as CSV.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} prisma     - Prisma client instance.
 * @param {object} filter     - Prisma `where` clause.
 * @param {object} logger     - Winston logger.
 * @param {string} correlationId
 * @returns {Promise<number>} Total rows written.
 */
const streamCsv = async (res, prisma, filter, logger, correlationId, options = {}) => {
  const maxPages = options.maxPages || MAX_PAGES;
  const onPage = typeof options.onPage === 'function' ? options.onPage : null;
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
  let page = 0;
  let totalRows = 0;
  let truncated = false;
  let headerWritten = false;

  for (; page < maxPages; page++) {
    if (isSinkClosed(res)) break;
    if (isCancelled && isCancelled()) break;

    const records = await prisma.payment.findMany({
      where: filter,
      select: {
        id: true,
        createdAt: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        assetCode: true,
        transactionHash: true,
        status: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    if (records.length === 0) break;

    try {
      const parser = new CsvParser({
        fields: EXPORT_FIELDS,
        // Only emit the header on the first page.
        header: !headerWritten,
        // Append a trailing newline so pages concatenate correctly.
        withBOM: false,
      });
      const chunk = parser.parse(records) + '\n';
      await writeChunk(res, chunk);
      headerWritten = true;
    } catch (parseErr) {
      logger.error(`[exporter][${correlationId}] CSV parse error on page ${page}:`, parseErr.message);
      throw parseErr;
    }

    totalRows += records.length;

    if (onPage) await onPage({ page: page + 1, rows: totalRows });

    if (records.length < PAGE_SIZE) break; // last page

    if (page === maxPages - 1) {
      truncated = true;
    }
  }

  if (truncated) {
    logger.warn(
      `[exporter][${correlationId}] CSV export hit ${maxPages}-page cap after ${totalRows} rows — truncated`,
    );
  }

  return totalRows;
};

/**
 * Streams admin transaction records to `res` as newline-delimited JSON
 * (one JSON object per line, no wrapping array).  This keeps memory use
 * bounded while producing a valid machine-readable format.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} prisma     - Prisma client instance.
 * @param {object} filter     - Prisma `where` clause.
 * @param {object} logger     - Winston logger.
 * @param {string} correlationId
 * @returns {Promise<number>} Total rows written.
 */
const streamJson = async (res, prisma, filter, logger, correlationId, options = {}) => {
  const maxPages = options.maxPages || MAX_PAGES;
  const onPage = typeof options.onPage === 'function' ? options.onPage : null;
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
  let page = 0;
  let totalRows = 0;
  let truncated = false;

  for (; page < maxPages; page++) {
    if (isSinkClosed(res)) break;
    if (isCancelled && isCancelled()) break;

    const records = await prisma.payment.findMany({
      where: filter,
      select: {
        id: true,
        createdAt: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        assetCode: true,
        transactionHash: true,
        status: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    if (records.length === 0) break;

    for (const record of records) {
      if (isSinkClosed(res)) return totalRows;
      await writeChunk(res, JSON.stringify(record) + '\n');
      totalRows += 1;
    }

    if (onPage) await onPage({ page: page + 1, rows: totalRows });

    if (records.length < PAGE_SIZE) break;

    if (page === maxPages - 1) {
      truncated = true;
    }
  }

  if (truncated) {
    logger.warn(
      `[exporter][${correlationId}] JSON export hit ${maxPages}-page cap after ${totalRows} rows — truncated`,
    );
  }

  return totalRows;
};

/**
 * Main entry point used by the admin export route handler.
 *
 * Sets the correct Content-Type / Content-Disposition headers and delegates
 * to the format-specific streamer.  The response is committed before streaming
 * begins, so mid-stream errors can only be logged and the connection cut.
 *
 * @param {object}  opts
 * @param {import('http').ServerResponse} opts.res
 * @param {object}  opts.prisma
 * @param {string}  opts.format      - 'csv' or 'json'
 * @param {string}  [opts.startDate]
 * @param {string}  [opts.endDate]
 * @param {object}  opts.logger
 * @param {string}  opts.correlationId
 */
const streamAdminExport = async ({
  res,
  prisma,
  format,
  startDate,
  endDate,
  logger,
  correlationId,
}) => {
  const dateFilter = buildDateFilter(startDate, endDate);
  const now = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${now}.ndjson"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);

    const rows = await streamJson(res, prisma, dateFilter, logger, correlationId);
    logger.info(`[exporter][${correlationId}] JSON export complete — ${rows} rows`);
  } else {
    // Default: CSV
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${now}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);

    const rows = await streamCsv(res, prisma, dateFilter, logger, correlationId);
    logger.info(`[exporter][${correlationId}] CSV export complete — ${rows} rows`);
  }

  res.end();
};

/**
 * Streams an admin export to a file on disk (artifact storage) instead of an
 * HTTP response.  Rows are paged from the database and written incrementally
 * so the whole export is never buffered in memory.
 *
 * The caller may supply:
 *  - `isCancelled()`: polled between pages; when it returns true the export
 *    stops early and the partial artifact is left for the caller to clean up.
 *  - `onProgress({ page, rows })`: invoked after each page is flushed.
 *
 * @param {object} opts
 * @param {string} opts.filePath        - Destination artifact path.
 * @param {object} opts.prisma          - Prisma client instance.
 * @param {string} opts.format          - 'csv' or 'json'
 * @param {string} [opts.startDate]
 * @param {string} [opts.endDate]
 * @param {object} opts.logger
 * @param {string} opts.correlationId
 * @param {number} [opts.maxPages]      - Override the page cap.
 * @param {() => boolean} [opts.isCancelled]
 * @param {(progress: {page: number, rows: number}) => (void|Promise<void>)} [opts.onProgress]
 * @returns {Promise<{rows: number, cancelled: boolean}>}
 */
const streamExportToFile = async ({
  filePath,
  prisma,
  format,
  startDate,
  endDate,
  logger,
  correlationId,
  maxPages,
  isCancelled,
  onProgress,
}) => {
  const dateFilter = buildDateFilter(startDate, endDate);
  const sink = fs.createWriteStream(filePath, { flags: 'w' });
  // Surface sink errors as rejections from the awaited writes below.
  const sinkError = new Promise((_, reject) => {
    sink.once('error', reject);
  });
  sinkError.catch(() => {});

  let cancelled = false;
  const options = {
    maxPages,
    isCancelled: () => {
      if (isCancelled && isCancelled()) {
        cancelled = true;
        return true;
      }
      return false;
    },
    onPage: onProgress
      ? async (progress) => {
          await onProgress(progress);
        }
      : null,
  };

  try {
    const rows =
      format === 'json'
        ? await Promise.race([
            streamJson(sink, prisma, dateFilter, logger, correlationId, options),
            sinkError,
          ])
        : await Promise.race([
            streamCsv(sink, prisma, dateFilter, logger, correlationId, options),
            sinkError,
          ]);

    await new Promise((resolve, reject) => {
      sink.end((err) => (err ? reject(err) : resolve()));
    });

    logger.info(
      `[exporter][${correlationId}] file export complete — ${rows} rows${cancelled ? ' (cancelled)' : ''}`,
    );
    return { rows, cancelled };
  } catch (err) {
    sink.destroy();
    throw err;
  }
};

module.exports = {
  streamAdminExport,
  streamExportToFile,
  buildDateFilter,
  EXPORT_FIELDS,
  PAGE_SIZE,
};
