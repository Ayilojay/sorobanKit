'use strict';

/**
 * tests/exporter.test.js
 *
 * Unit tests for src/utils/exporter.js (issue #489) — the streaming CSV / NDJSON
 * export helpers used by the admin export route.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exporter = require('../src/utils/exporter');
const {
  toUnits,
  fromUnits,
  formatUnits,
  STROOP_SCALE,
} = require('../src/utils/money');

// ── helpers ──────────────────────────────────────────────────────────────────

const makeRecord = (i) => ({
  id: `txn-${i}`,
  createdAt: new Date('2026-01-15T12:00:00Z'),
  fromAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  toAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  amount: String(i * 100),
  assetCode: 'XLM',
  transactionHash: `hash-${i}`,
  status: 'completed',
});

/**
 * A minimal stand-in for an HTTP ServerResponse: records headers/status and,
 * when `backpressure` is set, applies write backpressure that resolves after a
 * drain event (so writeChunk's drain-waiting path can be exercised end to end).
 */
const makeRes = ({ backpressure = false } = {}) => {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.headers = {};
  res.statusCode = 200;
  res.write = jest.fn(() => {
    if (backpressure) {
      backpressure = false;
      setImmediate(() => res.emit('drain'));
      return false;
    }
    return true;
  });
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.end = jest.fn(() => {
    res.writableEnded = true;
  });
  return res;
};

const makeLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const makePrisma = (findManyImpl) => ({
  payment: { findMany: jest.fn(findManyImpl) },
});

/**
 * A minimal writable sink that records every chunk and applies the same
 * backpressure contract as a real stream (write() -> boolean, 'drain' event).
 */
const makeSink = ({ backpressure = false } = {}) => {
  const sink = new EventEmitter();
  sink.chunks = [];
  sink.write = jest.fn((chunk) => {
    sink.chunks.push(String(chunk));
    if (backpressure) {
      backpressure = false;
      setImmediate(() => sink.emit('drain'));
      return false;
    }
    return true;
  });
  sink.end = jest.fn();
  sink.text = () => sink.chunks.join('');
  return sink;
};

const writtenText = (res) =>
  res.write.mock.calls.map(([chunk]) => String(chunk)).join('');

// ── buildDateFilter ──────────────────────────────────────────────────────────

describe('buildDateFilter', () => {
  it('returns an empty clause when neither date is given', () => {
    expect(exporter.buildDateFilter()).toEqual({});
    expect(exporter.buildDateFilter(undefined, undefined)).toEqual({});
  });

  it('builds a gte filter when only startDate is given', () => {
    const result = exporter.buildDateFilter('2026-08-01');
    expect(result.createdAt.gte).toEqual(new Date('2026-08-01'));
    expect(result.createdAt.lte).toBeUndefined();
  });

  it('builds an end-of-day lte filter when only endDate is given', () => {
    const result = exporter.buildDateFilter(undefined, '2026-08-15');
    expect(result.createdAt.gte).toBeUndefined();
    expect(result.createdAt.lte.toISOString()).toBe('2026-08-15T23:59:59.999Z');
  });

  it('builds both bounds when startDate and endDate are given', () => {
    const result = exporter.buildDateFilter('2026-08-01', '2026-08-15');
    expect(result.createdAt.gte).toEqual(new Date('2026-08-01'));
    expect(result.createdAt.lte.toISOString()).toBe('2026-08-15T23:59:59.999Z');
  });
});

// ── streamAdminExport (CSV) ──────────────────────────────────────────────────

describe('streamAdminExport CSV', () => {
  it('writes a header row plus one row per record', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const page = [makeRecord(1), makeRecord(2)];
    const prisma = makePrisma(async () => page);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-1',
    });

    expect(res.headers['Content-Type']).toMatch(/text\/csv/);
    expect(res.headers['Content-Disposition']).toMatch(/\.csv/);
    expect(res.end).toHaveBeenCalled();

    const text = writtenText(res);
    // Header row present — json2csv quotes field names by default.
    expect(text).toMatch(/"id"/);
    expect(text).toMatch(/txn-1/);
    expect(text).toMatch(/txn-2/);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('CSV export complete'));
  });

  it('returns an empty response when there are no records', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => []);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-2',
    });

    expect(writtenText(res).trim()).toBe('');
    expect(res.end).toHaveBeenCalled();
  });

  it('passes date bounds through to the prisma query', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => []);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      logger,
      correlationId: 'corr-3',
    });

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
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

  it('handles socket backpressure by waiting for drain', async () => {
    const res = makeRes({ backpressure: true });
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-4',
    });

    // Every record still made it to the response.
    expect(writtenText(res)).toMatch(/txn-2/);
    expect(res.end).toHaveBeenCalled();
  });

  it('logs a warning when the page cap truncates the export', async () => {
    process.env.EXPORT_MAX_PAGES = '2';
    try {
      const res = makeRes();
      const logger = makeLogger();
      const fullPage = Array.from({ length: exporter.PAGE_SIZE }, (_, i) => makeRecord(i));
      const prisma = makePrisma(async () => fullPage);

      await exporter.streamAdminExport({
        res,
        prisma,
        format: 'csv',
        logger,
        correlationId: 'corr-5',
      });

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
    } finally {
      delete process.env.EXPORT_MAX_PAGES;
    }
  });
});

// ── streamExportToSink (generic sink) ────────────────────────────────────────

describe('streamExportToSink', () => {
  it('streams CSV rows into an arbitrary writable sink', async () => {
    const sink = makeSink();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    const result = await exporter.streamExportToSink({
      sink,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'sink-1',
    });

    expect(sink.text()).toMatch(/txn-1/);
    expect(sink.text()).toMatch(/txn-2/);
    expect(result.rows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('streams NDJSON rows into an arbitrary writable sink', async () => {
    const sink = makeSink();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    const result = await exporter.streamExportToSink({
      sink,
      prisma,
      format: 'json',
      logger,
      correlationId: 'sink-2',
    });

    const lines = sink.text().trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe('txn-1');
    expect(result.rows).toBe(2);
  });

  it('writes to a real file stream on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-test-'));
    const filePath = path.join(dir, 'export.csv');
    const fileStream = fs.createWriteStream(filePath);
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2), makeRecord(3)]);

    try {
      const result = await exporter.streamExportToSink({
        sink: fileStream,
        prisma,
        format: 'csv',
        logger,
        correlationId: 'sink-file',
      });
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });

      const contents = fs.readFileSync(filePath, 'utf8');
      expect(contents).toMatch(/txn-1/);
      expect(contents).toMatch(/txn-3/);
      expect(result.rows).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invokes the progress callback after each page', async () => {
    const sink = makeSink();
    const logger = makeLogger();
    const onProgress = jest.fn();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    await exporter.streamExportToSink({
      sink,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'sink-progress',
      onProgress,
    });

    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1][0];
    expect(lastCall).toEqual(expect.objectContaining({ rows: 2 }));
  });

  it('stops mid-export when the cancellation predicate returns true', async () => {
    const sink = makeSink();
    const logger = makeLogger();
    const fullPage = Array.from({ length: exporter.PAGE_SIZE }, (_, i) => makeRecord(i));
    const prisma = makePrisma(async () => fullPage);
    let calls = 0;
    const isCancelled = jest.fn(() => {
      calls += 1;
      return calls > 1;
    });

    const result = await exporter.streamExportToSink({
      sink,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'sink-cancel',
      isCancelled,
    });

    expect(result.cancelled).toBe(true);
    // Only the first page was fetched before cancellation was observed.
    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
  });

  it('flushes each page incrementally instead of buffering the whole export', async () => {
    const sink = makeSink();
    const logger = makeLogger();
    const fullPage = Array.from({ length: exporter.PAGE_SIZE }, (_, i) => makeRecord(i));
    const prisma = makePrisma(async () => fullPage);
    process.env.EXPORT_MAX_PAGES = '3';
    try {
      await exporter.streamExportToSink({
        sink,
        prisma,
        format: 'csv',
        logger,
        correlationId: 'sink-bounded',
      });

      // One write per page (plus header) — never a single giant buffered write.
      expect(sink.write.mock.calls.length).toBeGreaterThan(1);
      expect(sink.write.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      delete process.env.EXPORT_MAX_PAGES;
    }
  });

  it('waits for drain when the sink applies backpressure', async () => {
    const sink = makeSink({ backpressure: true });
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    await exporter.streamExportToSink({
      sink,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'sink-backpressure',
    });

    expect(sink.text()).toMatch(/txn-2/);
  });
});

// ── streamAdminExport (JSON) ─────────────────────────────────────────────────

describe('streamAdminExport JSON', () => {
  it('writes one NDJSON line per record with the right headers', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeRecord(1), makeRecord(2)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'json',
      logger,
      correlationId: 'corr-6',
    });

    expect(res.headers['Content-Type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['Content-Disposition']).toMatch(/\.ndjson/);
    expect(res.end).toHaveBeenCalled();

    const lines = writtenText(res).trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe('txn-1');
    expect(JSON.parse(lines[1]).id).toBe('txn-2');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('JSON export complete'));
  });

  it('returns an empty response when there are no records', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => []);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'json',
      logger,
      correlationId: 'corr-7',
    });

    expect(writtenText(res).trim()).toBe('');
    expect(res.end).toHaveBeenCalled();
  });
});

// ── exact money units (issue #384) ───────────────────────────────────────────

describe('money units round-trip', () => {
  it('round-trips representable values at 7-decimal precision', () => {
    const samples = ['0', '0.0000001', '1', '1.2345678', '100', '99999999.9999999'];
    for (const value of samples) {
      const units = toUnits(value);
      expect(typeof units).toBe('bigint');
      expect(fromUnits(units)).toBe(value);
    }
  });

  it('round-trips integer units back to decimal strings', () => {
    expect(fromUnits(1n)).toBe('0.0000001');
    expect(fromUnits(10_000_000n)).toBe('1');
    expect(fromUnits(12_345_678n)).toBe('1.2345678');
    expect(fromUnits(0n)).toBe('0');
  });

  it('exposes the stroop scale', () => {
    expect(STROOP_SCALE).toBe(10_000_000n);
  });

  it('formats units as fixed-precision decimal strings', () => {
    expect(formatUnits(12_345_678n)).toBe('1.2345678');
    expect(formatUnits(10_000_000n)).toBe('1.0000000');
    expect(formatUnits(0n)).toBe('0.0000000');
  });

  it('rejects values with more than 7 decimal places', () => {
    expect(() => toUnits('0.00000001')).toThrow();
    expect(() => toUnits('1.12345678')).toThrow();
  });

  it('rejects non-numeric input', () => {
    expect(() => toUnits('abc')).toThrow();
    expect(() => toUnits(null)).toThrow();
    expect(() => toUnits(undefined)).toThrow();
  });
});

describe('money units half-up rounding boundaries', () => {
  it('rounds a half unit up', () => {
    expect(toUnits('0.00000005')).toBe(1n);
  });

  it('rounds below a half unit down', () => {
    expect(toUnits('0.00000004')).toBe(0n);
  });

  it('rounds negative halves away from zero (half-up)', () => {
    expect(toUnits('-0.00000005')).toBe(-1n);
    expect(toUnits('-0.00000004')).toBe(0n);
  });

  it('rounds larger fractional values correctly', () => {
    expect(toUnits('1.00000005')).toBe(10_000_001n);
    expect(toUnits('1.00000004')).toBe(10_000_000n);
  });
});

describe('exporter emits decimal strings for exact money', () => {
  const makeUnitRecord = (i) => ({
    id: `txn-${i}`,
    createdAt: new Date('2026-01-15T12:00:00Z'),
    fromAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    toAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    amountUnits: 12_345_678n,
    feeUnits: 100n,
    assetCode: 'XLM',
    transactionHash: `hash-${i}`,
    status: 'completed',
  });

  it('CSV export renders amount and fee as decimal strings', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeUnitRecord(1)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'csv',
      logger,
      correlationId: 'corr-money-1',
    });

    const text = writtenText(res);
    expect(text).toMatch(/1\.2345678/);
    expect(text).toMatch(/0\.0000100/);
  });

  it('JSON export renders amount and fee as decimal strings', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeUnitRecord(1)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'json',
      logger,
      correlationId: 'corr-money-2',
    });

    const line = JSON.parse(writtenText(res).trim().split('\n')[0]);
    expect(line.amount).toBe('1.2345678');
    expect(line.fee).toBe('0.0000100');
  });

  it('matches the previous Float output for representable values', async () => {
    const res = makeRes();
    const logger = makeLogger();
    const prisma = makePrisma(async () => [makeUnitRecord(1)]);

    await exporter.streamAdminExport({
      res,
      prisma,
      format: 'json',
      logger,
      correlationId: 'corr-money-3',
    });

    const line = JSON.parse(writtenText(res).trim().split('\n')[0]);
    // Previous Float serialization of the same value.
    expect(Number(line.amount)).toBe(1.2345678);
    expect(Number(line.fee)).toBe(0.00001);
  });
});
