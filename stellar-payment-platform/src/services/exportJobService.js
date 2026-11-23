'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');

const DEFAULT_WORKER_CONCURRENCY = 2;
const DEFAULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_PROGRESS_INTERVAL_MS = 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_CLAIM_BATCH = 10;

const STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

const FORMATS = Object.freeze({
  CSV: 'csv',
  JSON: 'json',
  NDJSON: 'ndjson',
});

class ExportJobError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'ExportJobError';
    this.statusCode = statusCode || 500;
    this.code = code || 'EXPORT_JOB_ERROR';
  }
}

function notFound() {
  return new ExportJobError('Export job not found', 404, 'EXPORT_JOB_NOT_FOUND');
}

function forbidden() {
  return new ExportJobError('You do not have access to this export job', 403, 'EXPORT_JOB_FORBIDDEN');
}

function conflict(message, code) {
  return new ExportJobError(message || 'Export job is not in a valid state for this operation', 409, code || 'EXPORT_JOB_CONFLICT');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function getWorkerConcurrency() {
  return parsePositiveInt(process.env.EXPORT_WORKER_CONCURRENCY, DEFAULT_WORKER_CONCURRENCY);
}

function getArtifactDir() {
  return process.env.EXPORT_ARTIFACT_DIR || path.join(process.cwd(), 'tmp', 'export-artifacts');
}

function getArtifactTtlMs() {
  return parsePositiveInt(process.env.EXPORT_ARTIFACT_TTL_MS, DEFAULT_ARTIFACT_TTL_MS);
}

function getPageSize() {
  return parsePositiveInt(process.env.EXPORT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
}

function getProgressIntervalMs() {
  return parsePositiveInt(process.env.EXPORT_PROGRESS_INTERVAL_MS, DEFAULT_PROGRESS_INTERVAL_MS);
}

function getCleanupIntervalMs() {
  return parsePositiveInt(process.env.EXPORT_CLEANUP_INTERVAL_MS, DEFAULT_CLEANUP_INTERVAL_MS);
}

function normalizeFormat(format) {
  const normalized = String(format || FORMATS.CSV).toLowerCase();
  if (!Object.values(FORMATS).includes(normalized)) {
    throw new ExportJobError(`Unsupported export format: ${format}`, 400, 'EXPORT_JOB_INVALID_FORMAT');
  }
  return normalized;
}

function normalizeFilters(filters) {
  if (filters == null) return {};
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ExportJobError('filters must be an object', 400, 'EXPORT_JOB_INVALID_FILTERS');
  }
  // Round-trip through JSON to guarantee a plain, serializable snapshot.
  try {
    return JSON.parse(JSON.stringify(filters));
  } catch (err) {
    throw new ExportJobError('filters must be JSON serializable', 400, 'EXPORT_JOB_INVALID_FILTERS');
  }
}

function getModels(deps) {
  if (deps && deps.models) return deps.models;
  // Lazy require to avoid circular dependency issues at module load time.
  // eslint-disable-next-line global-require
  const models = require('../models');
  return models;
}

function getExportJobModel(deps) {
  const models = getModels(deps);
  const model = models.ExportJob || (models.sequelize && models.sequelize.models && models.sequelize.models.ExportJob);
  if (!model) {
    throw new ExportJobError('ExportJob model is not available', 500, 'EXPORT_JOB_MODEL_MISSING');
  }
  return model;
}

function getExportSource(deps) {
  if (deps && typeof deps.fetchPage === 'function') return deps.fetchPage;
  if (deps && deps.exportSource && typeof deps.exportSource.fetchPage === 'function') {
    return deps.exportSource.fetchPage.bind(deps.exportSource);
  }
  // eslint-disable-next-line global-require
  const source = require('./exportSource');
  return source.fetchPage;
}

function getLogger(deps) {
  if (deps && deps.logger) return deps.logger;
  // eslint-disable-next-line global-require
  return require('../utils/logger');
}

function isOwner(job, userId) {
  if (!job) return false;
  const ownerId = job.ownerId != null ? job.ownerId : job.userId;
  return ownerId != null && String(ownerId) === String(userId);
}

async function loadOwnedJob(jobId, userId, deps) {
  const ExportJob = getExportJobModel(deps);
  const job = await ExportJob.findByPk(jobId);
  if (!job) throw notFound();
  if (!isOwner(job, userId)) throw forbidden();
  return job;
}

function serializeJob(job) {
  if (!job) return null;
  const plain = typeof job.get === 'function' ? job.get({ plain: true }) : job;
  return {
    id: plain.id,
    ownerId: plain.ownerId != null ? plain.ownerId : plain.userId,
    status: plain.status,
    format: plain.format,
    filters: plain.filters || {},
    progress: plain.progress != null ? plain.progress : 0,
    totalRows: plain.totalRows != null ? plain.totalRows : null,
    processedRows: plain.processedRows != null ? plain.processedRows : 0,
    error: plain.error || null,
    artifactPath: plain.artifactPath || null,
    artifactSize: plain.artifactSize != null ? plain.artifactSize : null,
    expiresAt: plain.expiresAt || null,
    startedAt: plain.startedAt || null,
    completedAt: plain.completedAt || null,
    cancelledAt: plain.cancelledAt || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
}

/**
 * Create a durable export job owned by `userId`.
 */
async function createExportJob({ userId, format, filters, ttlMs } = {}, deps = {}) {
  if (userId == null) {
    throw new ExportJobError('userId is required to create an export job', 400, 'EXPORT_JOB_INVALID_OWNER');
  }
  const ExportJob = getExportJobModel(deps);
  const normalizedFormat = normalizeFormat(format);
  const normalizedFilters = normalizeFilters(filters);
  const ttl = parsePositiveInt(ttlMs, getArtifactTtlMs());
  const expiresAt = new Date(Date.now() + ttl);

  const job = await ExportJob.create({
    ownerId: userId,
    userId,
    status: STATUS.PENDING,
    format: normalizedFormat,
    filters: normalizedFilters,
    progress: 0,
    processedRows: 0,
    totalRows: null,
    expiresAt,
  });

  return serializeJob(job);
}

/**
 * Get status of a job, enforcing ownership.
 */
async function getExportJobStatus(jobId, userId, deps = {}) {
  const job = await loadOwnedJob(jobId, userId, deps);
  return serializeJob(job);
}

/**
 * Cancel a job, enforcing ownership. Flips status to 'cancelled' and sets cancelledAt.
 */
async function cancelExportJob(jobId, userId, deps = {}) {
  const job = await loadOwnedJob(jobId, userId, deps);
  const terminal = [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.EXPIRED];
  if (terminal.includes(job.status)) {
    if (job.status === STATUS.CANCELLED) return serializeJob(job);
    throw conflict(`Cannot cancel a job in status '${job.status}'`, 'EXPORT_JOB_NOT_CANCELLABLE');
  }
  const now = new Date();
  await job.update({ status: STATUS.CANCELLED, cancelledAt: now });
  return serializeJob(job);
}

/**
 * Resolve a downloadable artifact for a job, enforcing ownership.
 * Returns { path, filename, size, contentType } or throws.
 */
async function getExportJobDownload(jobId, userId, deps = {}) {
  const job = await loadOwnedJob(jobId, userId, deps);
  if (job.status === STATUS.EXPIRED) {
    throw new ExportJobError('Export artifact has expired', 410, 'EXPORT_JOB_EXPIRED');
  }
  if (job.status !== STATUS.COMPLETED) {
    throw conflict(`Export job is not ready for download (status: '${job.status}')`, 'EXPORT_JOB_NOT_READY');
  }
  if (!job.artifactPath) {
    throw new ExportJobError('Export artifact is unavailable', 410, 'EXPORT_JOB_ARTIFACT_MISSING');
  }
  let stat;
  try {
    stat = await fsp.stat(job.artifactPath);
  } catch (err) {
    throw new ExportJobError('Export artifact is unavailable', 410, 'EXPORT_JOB_ARTIFACT_MISSING');
  }
  if (job.expiresAt && new Date(job.expiresAt).getTime() <= Date.now()) {
    throw new ExportJobError('Export artifact has expired', 410, 'EXPORT_JOB_EXPIRED');
  }
  const ext = job.format === FORMATS.JSON ? 'json' : job.format === FORMATS.NDJSON ? 'ndjson' : 'csv';
  const contentType = job.format === FORMATS.CSV ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8';
  return {
    path: job.artifactPath,
    filename: `export-${job.id}.${ext}`,
    size: stat.size,
    contentType: job.format === FORMATS.JSON ? 'application/json; charset=utf-8' : contentType,
  };
}

function buildArtifactPath(job) {
  const dir = getArtifactDir();
  const ext = job.format === FORMATS.JSON ? 'json' : job.format === FORMATS.NDJSON ? 'ndjson' : 'csv';
  return path.join(dir, `export-${job.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

function formatRow(row, format, isFirst) {
  if (format === FORMATS.JSON) {
    return `${isFirst ? '[' : ','}${JSON.stringify(row)}`;
  }
  if (format === FORMATS.NDJSON) {
    return `${JSON.stringify(row)}\n`;
  }
  // CSV
  const values = Object.values(row || {}).map((value) => {
    if (value == null) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  });
  return `${values.join(',')}\n`;
}

function formatHeader(format) {
  if (format === FORMATS.CSV) {
    // Header is derived from the first row's keys at write time.
    return null;
  }
  return null;
}

/**
 * Stream export rows page-by-page into an artifact file.
 * Never buffers the full result set in memory.
 */
async function writeArtifact(job, deps, { signal } = {}) {
  const fetchPage = getExportSource(deps);
  const pageSize = getPageSize();
  const progressInterval = getProgressIntervalMs();
  const artifactPath = buildArtifactPath(job);
  await fsp.mkdir(path.dirname(artifactPath), { recursive: true });

  const stream = fs.createWriteStream(artifactPath, { encoding: 'utf8' });
  const write = (chunk) => new Promise((resolve, reject) => {
    if (!stream.write(chunk)) {
      stream.once('drain', resolve);
      stream.once('error', reject);
    } else {
      resolve();
    }
  });

  let processed = 0;
  let offset = 0;
  let lastProgressAt = 0;
  let headerWritten = false;
  let firstJsonRow = true;
  let cancelled = false;

  const checkCancelled = async () => {
    if (signal && signal.aborted) return true;
    const ExportJob = getExportJobModel(deps);
    const fresh = await ExportJob.findByPk(job.id, { attributes: ['id', 'status'] });
    return !fresh || fresh.status === STATUS.CANCELLED;
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (await checkCancelled()) {
        cancelled = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const page = await fetchPage({
        filters: job.filters || {},
        format: job.format,
        limit: pageSize,
        offset,
      });
      const rows = Array.isArray(page) ? page : (page && page.rows) || [];
      const total = page && typeof page.total === 'number' ? page.total : null;

      if (rows.length === 0) break;

      let chunk = '';
      for (const row of rows) {
        if (job.format === FORMATS.CSV && !headerWritten) {
          chunk += `${Object.keys(row || {}).join(',')}\n`;
          headerWritten = true;
        }
        chunk += formatRow(row, job.format, firstJsonRow);
        if (job.format === FORMATS.JSON) firstJsonRow = false;
      }
      // eslint-disable-next-line no-await-in-loop
      await write(chunk);

      processed += rows.length;
      offset += rows.length;

      const now = Date.now();
      if (now - lastProgressAt >= progressInterval) {
        lastProgressAt = now;
        const ExportJob = getExportJobModel(deps);
        const progress = total && total > 0 ? Math.min(99, Math.floor((processed / total) * 100)) : null;
        // eslint-disable-next-line no-await-in-loop
        await ExportJob.update(
          {
            processedRows: processed,
            totalRows: total != null ? total : null,
            ...(progress != null ? { progress } : {}),
          },
          { where: { id: job.id, status: STATUS.RUNNING } },
        );
      }

      if (rows.length < pageSize) break;
    }

    if (job.format === FORMATS.JSON) {
      await write(firstJsonRow ? '[]' : ']');
    }

    await new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });

    if (cancelled) {
      await fsp.unlink(artifactPath).catch(() => {});
      return { cancelled: true, processedRows: processed };
    }

    const stat = await fsp.stat(artifactPath);
    return { cancelled: false, processedRows: processed, artifactPath, artifactSize: stat.size };
  } catch (err) {
    stream.destroy();
    await fsp.unlink(artifactPath).catch(() => {});
    throw err;
  }
}

async function processJob(job, deps) {
  const ExportJob = getExportJobModel(deps);
  const logger = getLogger(deps);
  const startedAt = new Date();
  await job.update({ status: STATUS.RUNNING, startedAt, progress: 0, error: null });

  try {
    const result = await writeArtifact(job, deps);
    if (result.cancelled) {
      await ExportJob.update(
        { status: STATUS.CANCELLED, cancelledAt: new Date() },
        { where: { id: job.id, status: { [Op.in]: [STATUS.RUNNING, STATUS.PENDING] } } },
      );
      return { status: STATUS.CANCELLED };
    }
    await ExportJob.update(
      {
        status: STATUS.COMPLETED,
        progress: 100,
        processedRows: result.processedRows,
        artifactPath: result.artifactPath,
        artifactSize: result.artifactSize,
        completedAt: new Date(),
      },
      { where: { id: job.id, status: STATUS.RUNNING } },
    );
    return { status: STATUS.COMPLETED };
  } catch (err) {
    if (logger && typeof logger.error === 'function') {
      logger.error({ err, jobId: job.id }, 'Export job failed');
    }
    await ExportJob.update(
      {
        status: STATUS.FAILED,
        error: err && err.message ? String(err.message).slice(0, 2000) : 'Unknown error',
        completedAt: new Date(),
      },
      { where: { id: job.id, status: STATUS.RUNNING } },
    );
    return { status: STATUS.FAILED, error: err };
  }
}

/**
 * Claim up to `limit` pending jobs atomically and return them.
 */
async function claimPendingJobs(limit, deps) {
  const ExportJob = getExportJobModel(deps);
  const candidates = await ExportJob.findAll({
    where: { status: STATUS.PENDING },
    order: [['createdAt', 'ASC']],
    limit,
  });
  const claimed = [];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const [updated] = await ExportJob.update(
      { status: STATUS.RUNNING, startedAt: new Date() },
      { where: { id: candidate.id, status: STATUS.PENDING } },
    );
    if (updated === 1) {
      // eslint-disable-next-line no-await-in-loop
      const fresh = await ExportJob.findByPk(candidate.id);
      if (fresh) claimed.push(fresh);
    }
  }
  return claimed;
}

/**
 * Bounded worker pool. Claims pending jobs and processes them with at most
 * EXPORT_WORKER_CONCURRENCY workers in parallel.
 */
async function runWorkerPool(deps = {}, options = {}) {
  const concurrency = parsePositiveInt(options.concurrency, getWorkerConcurrency());
  const logger = getLogger(deps);
  let active = 0;
  let processed = 0;
  let stop = false;

  const worker = async () => {
    while (!stop) {
      // eslint-disable-next-line no-await-in-loop
      const jobs = await claimPendingJobs(1, deps);
      if (jobs.length === 0) return;
      for (const job of jobs) {
        // eslint-disable-next-line no-await-in-loop
        await processJob(job, deps);
        processed += 1;
      }
    }
  };

  const workers = [];
  for (let i = 0; i < concurrency; i += 1) {
    active += 1;
    workers.push(
      worker()
        .catch((err) => {
          if (logger && typeof logger.error === 'function') {
            logger.error({ err }, 'Export worker crashed');
          }
        })
        .finally(() => {
          active -= 1;
        }),
    );
  }
  await Promise.all(workers);
  return { processed, concurrency };
}

/**
 * Delete expired artifacts and mark jobs 'expired'.
 */
async function cleanupExpiredJobs(deps = {}) {
  const ExportJob = getExportJobModel(deps);
  const logger = getLogger(deps);
  const now = new Date();
  const expired = await ExportJob.findAll({
    where: {
      expiresAt: { [Op.lte]: now },
      status: { [Op.in]: [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED] },
    },
  });

  let cleaned = 0;
  for (const job of expired) {
    if (job.artifactPath) {
      // eslint-disable-next-line no-await-in-loop
      await fsp.unlink(job.artifactPath).catch(() => {});
    }
    // eslint-disable-next-line no-await-in-loop
    await ExportJob.update(
      { status: STATUS.EXPIRED, artifactPath: null },
      { where: { id: job.id } },
    );
    cleaned += 1;
  }

  if (logger && typeof logger.info === 'function' && cleaned > 0) {
    logger.info({ cleaned }, 'Expired export jobs cleaned up');
  }
  return { cleaned };
}

/**
 * Recover orphaned 'running' jobs on startup by resetting them to 'pending'.
 */
async function recoverOrphanedJobs(deps = {}) {
  const ExportJob = getExportJobModel(deps);
  const logger = getLogger(deps);
  const [count] = await ExportJob.update(
    { status: STATUS.PENDING, startedAt: null, progress: 0 },
    { where: { status: STATUS.RUNNING } },
  );
  if (logger && typeof logger.info === 'function' && count > 0) {
    logger.info({ count }, 'Recovered orphaned export jobs');
  }
  return { recovered: count };
}

let cleanupTimer = null;

/**
 * Start the periodic cleanup routine. Returns a stop function.
 */
function startCleanupRoutine(deps = {}, options = {}) {
  const intervalMs = parsePositiveInt(options.intervalMs, getCleanupIntervalMs());
  const logger = getLogger(deps);
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    cleanupExpiredJobs(deps).catch((err) => {
      if (logger && typeof logger.error === 'function') {
        logger.error({ err }, 'Export cleanup routine failed');
      }
    });
  }, intervalMs);
  if (cleanupTimer.unref) cleanupTimer.unref();
  return () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  };
}

module.exports = {
  STATUS,
  FORMATS,
  ExportJobError,
  createExportJob,
  getExportJobStatus,
  cancelExportJob,
  getExportJobDownload,
  runWorkerPool,
  claimPendingJobs,
  processJob,
  writeArtifact,
  cleanupExpiredJobs,
  recoverOrphanedJobs,
  startCleanupRoutine,
  serializeJob,
  getWorkerConcurrency,
  getArtifactDir,
  getArtifactTtlMs,
  getPageSize,
  getProgressIntervalMs,
  getCleanupIntervalMs,
  normalizeFormat,
  normalizeFilters,
  isOwner,
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_ARTIFACT_TTL_MS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CLAIM_BATCH,
};