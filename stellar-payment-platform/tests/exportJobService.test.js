'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { ExportJobService } = require('../src/services/exportJobService');

/**
 * Minimal in-memory Prisma mock supporting the subset of operations
 * used by ExportJobService.
 */
function createMockPrisma() {
  const jobs = new Map();
  let idCounter = 0;

  const clone = (row) => (row ? { ...row } : row);

  const matchesWhere = (row, where) => {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('in' in value) return value.in.includes(row[key]);
        if ('lt' in value) return row[key] < value.lt;
        if ('lte' in value) return row[key] <= value.lte;
        if ('gt' in value) return row[key] > value.gt;
        if ('gte' in value) return row[key] >= value.gte;
        if ('not' in value) return row[key] !== value.not;
      }
      return row[key] === value;
    });
  };

  const exportJob = {
    async create({ data }) {
      idCounter += 1;
      const now = new Date();
      const row = {
        id: data.id || `job_${idCounter}`,
        status: 'pending',
        progress: 0,
        artifactPath: null,
        artifactExpiresAt: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        ...data,
      };
      jobs.set(row.id, row);
      return clone(row);
    },
    async findUnique({ where }) {
      const row = jobs.get(where.id);
      return clone(row);
    },
    async findFirst({ where } = {}) {
      for (const row of jobs.values()) {
        if (matchesWhere(row, where)) return clone(row);
      }
      return null;
    },
    async findMany({ where } = {}) {
      const out = [];
      for (const row of jobs.values()) {
        if (matchesWhere(row, where)) out.push(clone(row));
      }
      return out;
    },
    async update({ where, data }) {
      const row = jobs.get(where.id);
      if (!row) {
        const err = new Error('Record not found');
        err.code = 'P2025';
        throw err;
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return clone(row);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of jobs.values()) {
        if (matchesWhere(row, where)) {
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    },
    async delete({ where }) {
      const row = jobs.get(where.id);
      jobs.delete(where.id);
      return clone(row);
    },
    async deleteMany({ where } = {}) {
      let count = 0;
      for (const [id, row] of jobs.entries()) {
        if (matchesWhere(row, where)) {
          jobs.delete(id);
          count += 1;
        }
      }
      return { count };
    },
  };

  return {
    exportJob,
    $transaction: async (fn) => fn({ exportJob }),
    __jobs: jobs,
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'export-job-test-'));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Build a fake export source that yields `total` rows in chunks and
 * records how many rows were produced.
 */
function makeSource(total, { chunkSize = 10, delayMs = 0 } = {}) {
  let produced = 0;
  return {
    get produced() {
      return produced;
    },
    async *stream() {
      while (produced < total) {
        const end = Math.min(produced + chunkSize, total);
        const batch = [];
        for (let i = produced; i < end; i += 1) {
          batch.push({ id: i, value: `row-${i}` });
        }
        produced = end;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        yield batch;
      }
    },
  };
}

describe('ExportJobService', () => {
  let tmpDir;
  let prisma;
  let service;

  beforeEach(() => {
    tmpDir = makeTempDir();
    prisma = createMockPrisma();
    service = new ExportJobService({
      prisma,
      artifactDir: tmpDir,
      workerConcurrency: 2,
      artifactTtlMs: 60 * 1000,
    });
  });

  afterEach(async () => {
    if (service) {
      await service.shutdown();
    }
    rmrf(tmpDir);
  });

  describe('success path', () => {
    test('streams export to artifact and marks job completed', async () => {
      const source = makeSource(50, { chunkSize: 10 });
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
      });

      expect(job.status).toBe('pending');
      expect(job.ownerId).toBe('user-1');

      await service.runJob(job.id);

      const finished = await service.getJob(job.id, { ownerId: 'user-1' });
      expect(finished.status).toBe('completed');
      expect(finished.progress).toBe(100);
      expect(finished.artifactPath).toBeTruthy();
      expect(finished.artifactExpiresAt).toBeInstanceOf(Date);

      const artifactFullPath = path.join(tmpDir, finished.artifactPath);
      expect(fs.existsSync(artifactFullPath)).toBe(true);

      const contents = fs.readFileSync(artifactFullPath, 'utf8');
      const lines = contents.trim().split('\n');
      expect(lines).toHaveLength(50);
      expect(JSON.parse(lines[0])).toEqual({ id: 0, value: 'row-0' });
      expect(JSON.parse(lines[49])).toEqual({ id: 49, value: 'row-49' });
      expect(source.produced).toBe(50);
    });

    test('reports progress during run', async () => {
      const progressEvents = [];
      const source = makeSource(30, { chunkSize: 10, delayMs: 5 });
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
        totalRows: 30,
      });

      service.on('progress', (evt) => progressEvents.push(evt));

      await service.runJob(job.id);

      expect(progressEvents.length).toBeGreaterThan(0);
      const last = progressEvents[progressEvents.length - 1];
      expect(last.jobId).toBe(job.id);
      expect(last.progress).toBe(100);
    });

    test('rejects access from non-owner', async () => {
      const source = makeSource(5);
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
      });

      await expect(
        service.getJob(job.id, { ownerId: 'user-2' })
      ).rejects.toThrow(/not found|forbidden|access/i);
    });
  });

  describe('cancellation', () => {
    test('cancels a running job mid-stream', async () => {
      const source = makeSource(1000, { chunkSize: 10, delayMs: 5 });
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
        totalRows: 1000,
      });

      const runPromise = service.runJob(job.id);

      // Wait until the job has started producing.
      await new Promise((r) => setTimeout(r, 30));

      await service.cancelJob(job.id, { ownerId: 'user-1' });

      await runPromise;

      const finished = await service.getJob(job.id, { ownerId: 'user-1' });
      expect(finished.status).toBe('cancelled');
      expect(finished.cancelledAt).toBeInstanceOf(Date);
      expect(source.produced).toBeLessThan(1000);
    });

    test('cancelling a completed job is a no-op', async () => {
      const source = makeSource(5);
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
      });
      await service.runJob(job.id);

      await service.cancelJob(job.id, { ownerId: 'user-1' });

      const finished = await service.getJob(job.id, { ownerId: 'user-1' });
      expect(finished.status).toBe('completed');
    });

    test('non-owner cannot cancel', async () => {
      const source = makeSource(100, { chunkSize: 10, delayMs: 5 });
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
      });

      const runPromise = service.runJob(job.id);
      await new Promise((r) => setTimeout(r, 10));

      await expect(
        service.cancelJob(job.id, { ownerId: 'user-2' })
      ).rejects.toThrow(/not found|forbidden|access/i);

      await service.cancelJob(job.id, { ownerId: 'user-1' });
      await runPromise;
    });
  });

  describe('artifact expiration', () => {
    test('cleanup removes expired artifacts and clears references', async () => {
      const source = makeSource(5);
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
      });
      await service.runJob(job.id);

      const finished = await service.getJob(job.id, { ownerId: 'user-1' });
      const artifactFullPath = path.join(tmpDir, finished.artifactPath);
      expect(fs.existsSync(artifactFullPath)).toBe(true);

      // Force expiration.
      await prisma.exportJob.update({
        where: { id: job.id },
        data: { artifactExpiresAt: new Date(Date.now() - 1000) },
      });

      const removed = await service.cleanupExpiredArtifacts();
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(artifactFullPath)).toBe(false);

      const after = await prisma.exportJob.findUnique({ where: { id: job.id } });
      expect(after.artifactPath).toBeNull();
    });

    test('cleanup leaves unexpired artifacts intact', async () => {
      const source = makeSource(5);
      const job = await service.createJob({
        ownerId: 'user-1',
        type: 'payments',
        source,
      });
      await service.runJob(job.id);

      const finished = await service.getJob(job.id, { ownerId: 'user-1' });
      const artifactFullPath = path.join(tmpDir, finished.artifactPath);

      const removed = await service.cleanupExpiredArtifacts();
      expect(removed).toBe(0);
      expect(fs.existsSync(artifactFullPath)).toBe(true);
    });
  });

  describe('bounded worker concurrency', () => {
    test('never runs more than EXPORT_WORKER_CONCURRENCY jobs at once', async () => {
      const concurrency = 2;
      let active = 0;
      let maxActive = 0;

      const makeTrackedSource = () => {
        let produced = 0;
        return {
          async *stream() {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
              while (produced < 20) {
                await new Promise((r) => setTimeout(r, 5));
                const batch = [];
                for (let i = 0; i < 5 && produced < 20; i += 1) {
                  batch.push({ id: produced });
                  produced += 1;
                }
                yield batch;
              }
            } finally {
              active -= 1;
            }
          },
        };
      };

      const jobs = [];
      for (let i = 0; i < 6; i += 1) {
        jobs.push(
          await service.createJob({
            ownerId: `user-${i}`,
            type: 'payments',
            source: makeTrackedSource(),
            totalRows: 20,
          })
        );
      }

      await Promise.all(jobs.map((j) => service.runJob(j.id)));

      expect(maxActive).toBeLessThanOrEqual(concurrency);
      expect(maxActive).toBeGreaterThan(0);

      for (const j of jobs) {
        const finished = await service.getJob(j.id, { ownerId: j.ownerId });
        expect(finished.status).toBe('completed');
      }
    });
  });

  describe('recovery', () => {
    test('recovers orphaned running jobs on startup', async () => {
      const orphan = await prisma.exportJob.create({
        data: {
          ownerId: 'user-1',
          type: 'payments',
          status: 'running',
          progress: 40,
          startedAt: new Date(Date.now() - 60_000),
        },
      });

      const recovered = await service.recoverOrphanedJobs();
      expect(recovered).toBeGreaterThanOrEqual(1);

      const after = await prisma.exportJob.findUnique({
        where: { id: orphan.id },
      });
      expect(after.status).toBe('failed');
      expect(after.error).toMatch(/interrupted|recovered|restart/i);
    });

    test('does not touch completed or cancelled jobs during recovery', async () => {
      const completed = await prisma.exportJob.create({
        data: {
          ownerId: 'user-1',
          type: 'payments',
          status: 'completed',
          progress: 100,
        },
      });
      const cancelled = await prisma.exportJob.create({
        data: {
          ownerId: 'user-1',
          type: 'payments',
          status: 'cancelled',
          progress: 10,
        },
      });

      await service.recoverOrphanedJobs();

      const c1 = await prisma.exportJob.findUnique({
        where: { id: completed.id },
      });
      const c2 = await prisma.exportJob.findUnique({
        where: { id: cancelled.id },
      });
      expect(c1.status).toBe('completed');
      expect(c2.status).toBe('cancelled');
    });
  });
});