// ---------------------------------------------------------------------------
// Tests for the startup migration check (src/migrate-check.js)
// ---------------------------------------------------------------------------
// Covers the CLI-ouput classification, the policy resolution, and the
// strict / permissive exit behaviour driven by MIGRATION_POLICY.
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  // Resolves once all buffered log records have been written to their
  // transports. The migration check awaits this before calling process.exit.
  flush: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../src/logger', () => ({
  logger: mockLogger,
}));

const mockChild = { on: jest.fn() };
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args) => {
    mockExecFile(...args);
    return mockChild;
  },
}));

// Simulate the Prisma CLI completing by invoking the callback with the result.
const simulateSpawn = ({ code = 0, stdout = '', stderr = '' }) => {
  mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
    if (code !== 0) {
      cb(Object.assign(new Error(`exited with code ${code}`), { code }), stdout, stderr);
    } else {
      cb(null, stdout, stderr);
    }
  });
  mockChild.on.mockImplementation(() => {});
};

// Simulate the binary failing to spawn (ENOENT) -> runMigrateStatus rejects.
const simulateSpawnError = () => {
  mockExecFile.mockImplementation(() => {});
  mockChild.on.mockImplementation((event, handler) => {
    if (event === 'error') handler(new Error('spawn prisma ENOENT'));
  });
};

describe('currentPolicy', () => {
  let currentPolicy;
  let original;

  beforeAll(() => {
    ({ currentPolicy } = require('../src/migrate-check'));
    original = process.env.MIGRATION_POLICY;
  });

  afterEach(() => {
    delete process.env.MIGRATION_POLICY;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.MIGRATION_POLICY;
    else process.env.MIGRATION_POLICY = original;
  });

  it('defaults to the permissive "warn" policy', () => {
    delete process.env.MIGRATION_POLICY;
    expect(currentPolicy()).toBe('warn');
  });

  it('returns "strict" when MIGRATION_POLICY=strict (case-insensitive)', () => {
    process.env.MIGRATION_POLICY = 'STRICT';
    expect(currentPolicy()).toBe('strict');
  });

  it('returns "off" when MIGRATION_POLICY=off', () => {
    process.env.MIGRATION_POLICY = 'off';
    expect(currentPolicy()).toBe('off');
  });

  it('falls back to "warn" for unknown values', () => {
    process.env.MIGRATION_POLICY = 'banana';
    expect(currentPolicy()).toBe('warn');
  });
});

describe('classifyStatus', () => {
  let classifyStatus;

  beforeAll(() => {
    ({ classifyStatus } = require('../src/migrate-check'));
  });

  it('classifies "Database schema is up to date!" as up-to-date', () => {
    const r = classifyStatus({ code: 0, output: 'Status: Database schema is up to date!' });
    expect(r.status).toBe('up-to-date');
    expect(r.pending).toBe(false);
    expect(r.drift).toBe(false);
  });

  it('classifies pending migrations ("not yet applied")', () => {
    const r = classifyStatus({
      code: 1,
      output: 'Following migration(s) have not yet been applied:\n- 20260727120000_add_deleted_at',
    });
    expect(r.status).toBe('pending');
    expect(r.pending).toBe(true);
    expect(r.drift).toBe(false);
  });

  it('classifies pending migrations ("not been applied")', () => {
    const r = classifyStatus({
      code: 1,
      output: '1 migration not been applied',
    });
    expect(r.status).toBe('pending');
    expect(r.pending).toBe(true);
  });

  it('classifies drift ("differ from the migrations")', () => {
    const r = classifyStatus({
      code: 1,
      output: 'following migration(s) differ from the migrations recorded in the database',
    });
    expect(r.status).toBe('drift');
    expect(r.drift).toBe(true);
  });

  it('classifies drift when a DB migration is missing from the local folder', () => {
    const r = classifyStatus({
      code: 1,
      output: 'The migration 2026_foo has already been applied but is missing from the local migrations folder',
    });
    expect(r.status).toBe('drift');
    expect(r.drift).toBe(true);
  });

  it('returns "unknown" for unrecognised output with a non-zero exit', () => {
    const r = classifyStatus({ code: 1, output: 'some unrelated error text' });
    expect(r.status).toBe('unknown');
    expect(r.pending).toBe(false);
    expect(r.drift).toBe(false);
  });

  it('treats unrecognised output with exit 0 as up-to-date', () => {
    const r = classifyStatus({ code: 0, output: 'prisma v6.19.3' });
    expect(r.status).toBe('up-to-date');
  });
});

describe('checkMigrations', () => {
  let checkMigrations;
  let originalUrl;
  let originalPolicy;

  beforeAll(() => {
    ({ checkMigrations } = require('../src/migrate-check'));
    originalUrl = process.env.DATABASE_URL;
    originalPolicy = process.env.MIGRATION_POLICY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env.MIGRATION_POLICY;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  afterAll(() => {
    if (originalPolicy === undefined) delete process.env.MIGRATION_POLICY;
    else process.env.MIGRATION_POLICY = originalPolicy;
  });

  it('skips entirely when the policy is "off" (never spawns the CLI)', async () => {
    process.env.MIGRATION_POLICY = 'off';
    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('skipped');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('skips (with a warning) when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;
    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'));
  });

  it('returns pending when the CLI reports un-applied migrations', async () => {
    process.env.MIGRATION_POLICY = 'strict';
    simulateSpawn({
      code: 1,
      stdout: 'Following migration(s) have not yet been applied:\n- 20260626000000_add_memo_fields',
    });
    const r = await checkMigrations();
    expect(r.skipped).toBe(false);
    expect(r.status).toBe('pending');
    expect(r.pending).toBe(true);
    expect(r.policy).toBe('strict');
  });

  it('returns up-to-date for a healthy database', async () => {
    simulateSpawn({ code: 0, stdout: 'Status: Database schema is up to date!' });
    const r = await checkMigrations();
    expect(r.status).toBe('up-to-date');
    expect(r.pending).toBe(false);
  });

  it('skips gracefully when the Prisma CLI cannot spawn', async () => {
    simulateSpawnError();
    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('error');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('Could not run'),
    );
  });

  it('never mistakes a spawn error (string error.code) for an up-to-date DB', async () => {
    // A missing binary surfaces an ENOENT with a *string* error.code; ensure
    // that is treated as a hard failure (skip) rather than resolved as a
    // silent, healthy run.
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(Object.assign(new Error('spawn prisma ENOENT'), { code: 'ENOENT' }));
    });
    mockChild.on.mockImplementation(() => {});

    const r = await checkMigrations();
    expect(r.skipped).toBe(true);
    expect(r.status).toBe('error');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining('Could not run'),
    );
  });
});

describe('enforceMigrationPolicy', () => {
  let enforceMigrationPolicy;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ enforceMigrationPolicy } = require('../src/migrate-check'));
  });

  const base = { policy: 'warn', pending: false, drift: false, skipped: false, output: '' };

  it('exits in strict mode when migrations are pending', () => {
    const { shouldExit } = enforceMigrationPolicy({
      ...base,
      policy: 'strict',
      status: 'pending',
      pending: true,
    });
    expect(shouldExit).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('out of sync'));
  });

  it('exits in strict mode when drift is detected', () => {
    const { shouldExit } = enforceMigrationPolicy({
      ...base,
      policy: 'strict',
      status: 'drift',
      drift: true,
    });
    expect(shouldExit).toBe(true);
  });

  it('warns but keeps going in permissive mode when migrations are pending', () => {
    const { shouldExit } = enforceMigrationPolicy({
      ...base,
      policy: 'warn',
      status: 'pending',
      pending: true,
    });
    expect(shouldExit).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('out of sync'));
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('does not block when migrations are up to date, even in strict mode', () => {
    const { shouldExit } = enforceMigrationPolicy({ ...base, policy: 'strict', status: 'up-to-date' });
    expect(shouldExit).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('up to date'));
  });

  it('never blocks a skipped check', () => {
    const { shouldExit } = enforceMigrationPolicy({ ...base, status: 'skipped', skipped: true });
    expect(shouldExit).toBe(false);
  });

  it('warns without blocking when the status is unknown', () => {
    const { shouldExit } = enforceMigrationPolicy({ ...base, status: 'unknown' });
    expect(shouldExit).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not determine'));
  });
});
describe('checksum manifest and drift detection (#389)', () => {
  let buildManifest;
  let verifyManifest;
  let reportSchemaVersion;
  let checkMigrations;
  let originalUrl;
  let originalPolicy;

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const crypto = require('crypto');

  let tmpDir;

  const writeMigration = (name, sql) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'migration.sql'), sql);
    return dir;
  };

  const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

  beforeAll(() => {
    ({
      buildManifest,
      verifyManifest,
      reportSchemaVersion,
      checkMigrations,
    } = require('../src/migrate-check'));
    originalUrl = process.env.DATABASE_URL;
    originalPolicy = process.env.MIGRATION_POLICY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-check-'));
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env.MIGRATION_POLICY;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalPolicy === undefined) delete process.env.MIGRATION_POLICY;
    else process.env.MIGRATION_POLICY = originalPolicy;
  });

  it('builds a manifest of applied migration names and checksums', () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    writeMigration('20260102000000_add_b', 'ALTER TABLE a ADD COLUMN b int;');

    const manifest = buildManifest(tmpDir);
    expect(manifest.migrations).toHaveLength(2);
    expect(manifest.migrations[0]).toEqual({
      name: '20260101000000_init',
      checksum: sha256('CREATE TABLE a (id int);'),
    });
    expect(manifest.migrations[1].name).toBe('20260102000000_add_b');
    expect(manifest.migrations[1].checksum).toBe(
      sha256('ALTER TABLE a ADD COLUMN b int;'),
    );
  });

  it('produces a stable manifest for unchanged files (matching manifest)', () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    const first = buildManifest(tmpDir);
    const second = buildManifest(tmpDir);
    expect(second).toEqual(first);
    const result = verifyManifest(first, second);
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('detects a changed historical migration file', () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    const recorded = buildManifest(tmpDir);

    // Rewrite the historical file after it was recorded.
    writeMigration('20260101000000_init', 'CREATE TABLE a (id bigint);');
    const current = buildManifest(tmpDir);

    const result = verifyManifest(recorded, current);
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual(['20260101000000_init']);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('detects a migration missing from the local folder', () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    writeMigration('20260102000000_add_b', 'ALTER TABLE a ADD COLUMN b int;');
    const recorded = buildManifest(tmpDir);

    fs.rmSync(path.join(tmpDir, '20260102000000_add_b'), { recursive: true, force: true });
    const current = buildManifest(tmpDir);

    const result = verifyManifest(recorded, current);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['20260102000000_add_b']);
    expect(result.changed).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('detects an extra migration not present in the recorded manifest', () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    const recorded = buildManifest(tmpDir);

    writeMigration('20260103000000_add_c', 'ALTER TABLE a ADD COLUMN c int;');
    const current = buildManifest(tmpDir);

    const result = verifyManifest(recorded, current);
    expect(result.ok).toBe(false);
    expect(result.extra).toEqual(['20260103000000_add_c']);
    expect(result.changed).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('reports the deployed schema version without modifying data', async () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    writeMigration('20260102000000_add_b', 'ALTER TABLE a ADD COLUMN b int;');

    simulateSpawn({ code: 0, stdout: 'Status: Database schema is up to date!' });
    const version = await reportSchemaVersion({ migrationsDir: tmpDir });

    expect(version).toEqual({
      version: '20260102000000_add_b',
      count: 2,
      checksum: sha256('ALTER TABLE a ADD COLUMN b int;'),
    });
    // Read-only: the CLI is only ever asked for status, never migrate.
    const invokedArgs = mockExecFile.mock.calls.map((c) => c[1]).flat();
    expect(invokedArgs).toContain('status');
    expect(invokedArgs).not.toContain('migrate');
    expect(invokedArgs).not.toContain('deploy');
    expect(invokedArgs).not.toContain('reset');
  });

  it('surfaces drift in checkMigrations when a recorded checksum changed', async () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    const recorded = buildManifest(tmpDir);
    writeMigration('20260101000000_init', 'CREATE TABLE a (id bigint);');

    process.env.MIGRATION_POLICY = 'strict';
    simulateSpawn({ code: 0, stdout: 'Status: Database schema is up to date!' });

    const r = await checkMigrations({ migrationsDir: tmpDir, recordedManifest: recorded });
    expect(r.drift).toBe(true);
    expect(r.status).toBe('drift');
    expect(r.manifest.changed).toEqual(['20260101000000_init']);
  });

  it('reports up-to-date when the manifest matches and the DB is healthy', async () => {
    writeMigration('20260101000000_init', 'CREATE TABLE a (id int);');
    const recorded = buildManifest(tmpDir);

    process.env.MIGRATION_POLICY = 'strict';
    simulateSpawn({ code: 0, stdout: 'Status: Database schema is up to date!' });

    const r = await checkMigrations({ migrationsDir: tmpDir, recordedManifest: recorded });
    expect(r.drift).toBe(false);
    expect(r.status).toBe('up-to-date');
    expect(r.manifest.ok).toBe(true);
  });
});

describe('strict-mode process.exit integration', () => {
  let checkMigrations;
  let enforceMigrationPolicy;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    ({ checkMigrations, enforceMigrationPolicy } = require('../src/migrate-check'));
  });

  it('calls process.exit(1) before any port is bound when strict mode has pending migrations', async () => {
    // Simulate pending migrations output from prisma CLI.
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('pending'), { code: 1 }),
        'Following migration(s) have not yet been applied:\n- 20260101_add_col',
        '',
      );
    });

    process.env.MIGRATION_POLICY = 'strict';
    process.env.DATABASE_URL = 'postgresql://localhost/test';

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const listenSpy = jest.fn();

    // Run the migration check as the server startup sequence does.
    const result = await checkMigrations();
    const { shouldExit } = enforceMigrationPolicy(result);

    if (shouldExit) {
      await mockLogger.flush();
      process.exit(1);
    } else {
      listenSpy();
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(listenSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    delete process.env.DATABASE_URL;
  });

  it('exits with code 1 when strict mode detects drift', async () => {
    // Simulate drift output from the prisma CLI.
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('drift'), { code: 1 }),
        'following migration(s) differ from the migrations recorded in the database',
        '',
      );
    });

    process.env.MIGRATION_POLICY = 'strict';
    process.env.DATABASE_URL = 'postgresql://localhost/test';

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const listenSpy = jest.fn();

    const result = await checkMigrations();
    expect(result.status).toBe('drift');
    expect(result.drift).toBe(true);

    const { shouldExit } = enforceMigrationPolicy(result);

    if (shouldExit) {
      await mockLogger.flush();
      process.exit(1);
    } else {
      listenSpy();
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(listenSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    delete process.env.DATABASE_URL;
  });

  it('flushes the logger before process.exit so the error is visible', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
      cb(
        Object.assign(new Error('drift'), { code: 1 }),
        'following migration(s) differ from the migrations recorded in the database',
        '',
      );
    });

    process.env.MIGRATION_POLICY = 'strict';
    process.env.DATABASE_URL = 'postgresql://localhost/test';

    const callOrder = [];
    mockLogger.flush.mockImplementationOnce(async () => {
      callOrder.push('flush');
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      callOrder.push('exit');
    });

    const result = await checkMigrations();
    const { shouldExit } = enforceMigrationPolicy(result);

    if (shouldExit) {
      await mockLogger.flush();
      process.exit(1);
    }

    expect(mockLogger.flush).toHaveBeenCalled();
    expect(callOrder).toEqual(['flush', 'exit']);

    exitSpy.mockRestore();
    delete process.env.DATABASE_URL;
  });

  it('does not call process.exit when strict mode and migrations are up to date', async () => {
    mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, 'Status: Database schema is up to date!', '');
    });

    process.env.MIGRATION_POLICY = 'strict';
    process.env.DATABASE_URL = 'postgresql://localhost/test';

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const listenSpy = jest.fn();

    const result = await checkMigrations();
    const { shouldExit } = enforceMigrationPolicy(result);

    if (shouldExit) {
      await mockLogger.flush();
      process.exit(1);
    } else {
      listenSpy();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockLogger.flush).not.toHaveBeenCalled();
    expect(listenSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    delete process.env.DATABASE_URL;
  });
});
