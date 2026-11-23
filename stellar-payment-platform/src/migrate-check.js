'use strict';

// ---------------------------------------------------------------------------
// Startup migration check
// ---------------------------------------------------------------------------
// Runs `prisma migrate status` at server startup so schema drift between the
// code and the database is caught immediately, instead of surfacing later as
// a cryptic error on the first query.
//
// Behaviour is controlled by the MIGRATION_POLICY environment variable:
//   - "strict" -> exit the process (non-zero) before the server binds a port
//                 whenever migrations are pending or drift is detected, so an
//                 orchestrator can restart a correctly-migrated instance.
//   - "off"    -> skip the check entirely.
//   - anything else ("warn", the default) -> log a clear warning but continue
//                 booting so local dev / mock databases keep working.
//
// The standalone CLI (`prisma migrate status`) is invoked on purpose: it is
// the same source of truth the `prisma migrate deploy` step in startup.sh uses
// and needs no extra runtime dependencies beyond the already-shipped CLI.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { logger } = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '..');
const PRISMA_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'prisma');

/** Directory holding the Prisma migration folders. */
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'prisma', 'migrations');

/**
 * Manifest of applied migration names + checksums. Overridable so tests and
 * deployments can point at a different location.
 */
const MANIFEST_PATH =
  process.env.MIGRATION_MANIFEST_PATH ||
  path.join(PROJECT_ROOT, 'prisma', 'migrations.manifest.json');

/** Manifest schema version, bumped if the on-disk format ever changes. */
const MANIFEST_VERSION = 1;

/** How long to wait for `prisma migrate status` before giving up. */
const MIGRATION_CHECK_TIMEOUT_MS =
  parseInt(process.env.MIGRATION_CHECK_TIMEOUT_MS, 10) || 30_000;

const POLICIES = new Set(['strict', 'warn', 'off']);

/**
 * Computes the SHA-256 checksum of a buffer or string.
 * @param {Buffer|string} data
 * @returns {string} lowercase hex digest
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Recursively lists every regular file under `dir`, returning paths relative to
 * `dir` with forward slashes so checksums are stable across platforms.
 * @param {string} dir
 * @param {string} [base]
 * @returns {string[]}
 */
function listFilesRecursive(dir, base = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(abs, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

/**
 * Computes SHA-256 checksums for every file inside each migration folder.
 *
 * @param {string} [migrationsDir]
 * @returns {Array<{ name: string, checksum: string, files: Record<string,string> }>}
 *   One entry per migration directory, sorted by name. `checksum` is a digest
 *   over the sorted per-file digests so it changes if any file changes.
 */
function computeMigrationChecksums(migrationsDir = MIGRATIONS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const migrations = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(migrationsDir, entry.name);
    const files = {};
    for (const rel of listFilesRecursive(dir)) {
      files[rel] = sha256(fs.readFileSync(path.join(dir, rel)));
    }
    const combined = Object.keys(files)
      .sort()
      .map((rel) => `${rel}:${files[rel]}`)
      .join('\n');
    migrations.push({ name: entry.name, checksum: sha256(combined), files });
  }

  return migrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Loads the persisted manifest from disk. Returns an empty manifest when the
 * file is missing or unreadable so callers can treat it as "nothing recorded".
 *
 * @param {string} [manifestPath]
 * @returns {{ version: number, migrations: Array<{ name: string, checksum: string }> }}
 */
function loadManifest(manifestPath = MANIFEST_PATH) {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    const migrations = Array.isArray(parsed && parsed.migrations) ? parsed.migrations : [];
    return {
      version: (parsed && parsed.version) || MANIFEST_VERSION,
      migrations: migrations
        .filter((m) => m && typeof m.name === 'string' && typeof m.checksum === 'string')
        .map((m) => ({ name: m.name, checksum: m.checksum })),
    };
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) {
      return { version: MANIFEST_VERSION, migrations: [] };
    }
    throw err;
  }
}

/**
 * Persists the manifest to disk atomically (write temp file + rename).
 * @param {{ version?: number, migrations: Array<{ name: string, checksum: string }> }} manifest
 * @param {string} [manifestPath]
 * @returns {string} the path written
 */
function saveManifest(manifest, manifestPath = MANIFEST_PATH) {
  const payload = {
    version: manifest.version || MANIFEST_VERSION,
    migrations: (manifest.migrations || []).map((m) => ({
      name: m.name,
      checksum: m.checksum,
    })),
  };
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, manifestPath);
  return manifestPath;
}

/**
 * Compares the current migration files against the recorded manifest.
 *
 * Read-only: never writes to disk or the database.
 *
 * @param {{
 *   migrations?: Array<{ name: string, checksum: string }>,
 *   manifest?: { migrations: Array<{ name: string, checksum: string }> },
 * }} [options]
 * @returns {{
 *   schemaVersion: string | null,
 *   changed: string[],
 *   missing: string[],
 *   extra: string[],
 *   unrecorded: string[],
 *   drift: boolean,
 * }}
 */
function compareManifest({ migrations, manifest } = {}) {
  const current = migrations || computeMigrationChecksums();
  const recorded = (manifest || loadManifest()).migrations || [];

  const currentByName = new Map(current.map((m) => [m.name, m.checksum]));
  const recordedByName = new Map(recorded.map((m) => [m.name, m.checksum]));

  const changed = [];
  const missing = [];
  const extra = [];
  const unrecorded = [];

  for (const [name, checksum] of recordedByName) {
    if (!currentByName.has(name)) {
      missing.push(name);
    } else if (currentByName.get(name) !== checksum) {
      changed.push(name);
    }
  }
  for (const name of currentByName.keys()) {
    if (!recordedByName.has(name)) unrecorded.push(name);
  }
  for (const name of recordedByName.keys()) {
    if (!currentByName.has(name)) extra.push(name);
  }

  // Highest migration name present in the manifest is the deployed version.
  const appliedNames = recorded.map((m) => m.name).sort();
  const schemaVersion = appliedNames.length ? appliedNames[appliedNames.length - 1] : null;

  return {
    schemaVersion,
    changed: changed.sort(),
    missing: missing.sort(),
    extra: extra.sort(),
    unrecorded: unrecorded.sort(),
    drift: changed.length > 0 || missing.length > 0,
  };
}

/**
 * Builds a read-only report of the deployed schema version and any checksum
 * drift. Never mutates the manifest or the database.
 *
 * @param {{ migrationsDir?: string, manifestPath?: string }} [options]
 * @returns {ReturnType<typeof compareManifest>}
 */
function getSchemaReport({ migrationsDir = MIGRATIONS_DIR, manifestPath = MANIFEST_PATH } = {}) {
  const migrations = computeMigrationChecksums(migrationsDir);
  const manifest = loadManifest(manifestPath);
  return compareManifest({ migrations, manifest });
}

/**
 * Resolves the active migration policy from MIGRATION_POLICY, defaulting to
 * the permissive "warn" mode.
 * @returns {'strict' | 'warn' | 'off'}
 */
function currentPolicy() {
  const raw = (process.env.MIGRATION_POLICY || 'warn').trim().toLowerCase();
  return POLICIES.has(raw) ? raw : 'warn';
}

/**
 * Runs the Prisma CLI directly against the configured database.
 * @returns {Promise<{ code: number, output: string }>}
 */
function runMigrateStatus() {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PRISMA_BIN,
      ['migrate', 'status'],
      {
        cwd: PROJECT_ROOT,
        timeout: MIGRATION_CHECK_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Prisma writes diagnostics to both streams, so merge them.
        const output = `${stdout || ''}${stderr || ''}`;
        if (!error) {
          resolve({ code: 0, output });
          return;
        }
        if (typeof error.code === 'number') {
          // The CLI ran and exited non-zero (e.g. pending migrations / drift).
          // That is exactly the "out of sync" signal we want to inspect, not a
          // hard failure, so we capture it instead of rejecting.
          resolve({ code: error.code, output });
          return;
        }
        // Spawn-level failure (ENOENT, EACCES, timeout...). error.code is a
        // string here (e.g. 'ENOENT'), NOT a child exit code — treat it as a
        // hard failure so checkMigrations skips instead of guessing.
        reject(error);
      },
    );
    // Binary-level failure only (ENOENT, EACCES, spawn error). Kept as a guard
    // in case execFile reports the failure via the child 'error' event rather
    // than the completion callback.
    child.on('error', reject);
  });
}

/**
 * Classifies the raw `prisma migrate status` output into a machine-readable
 * result. Matching is deliberately lenient because wording differs across
 * Prisma CLI versions.
 * @param {{ code: number, output: string }} raw
 * @returns {{ status: string, pending: boolean, drift: boolean, output: string }}
 */
function classifyStatus({ code, output }) {
  const text = (output || '').toLowerCase();
  const has = (...needles) => needles.some((needle) => text.includes(needle));

  const result = (status, pending, drift) => ({
    status,
    pending,
    drift,
    output,
  });

  if (has('up to date')) {
    return result('up-to-date', false, false);
  }
  // New migration(s) recorded in the schema but not yet applied to the DB.
  // Match flexibly because wording varies across versions, e.g.
  // "not yet been applied", "have not yet been applied", "not been applied".
  if (/\bnot (?:yet )?been applied\b/.test(text) || has('not applied')) {
    return result('pending', true, false);
  }
  // The DB has been changed in a way the local migrations don't record
  // (drift), or the DB has migrations not present in the local folder.
  if (
    has(
      'differ from the migrations',
      'drift',
      'already been applied',
      'missing from the local migrations folder',
    )
  ) {
    return result('drift', false, true);
  }
  // Nothing recognisable matched. Never pretend a non-zero CLI run is healthy:
  // surface it so drift is never silently hidden behind an unknown state.
  if (code !== 0) {
    return result('unknown', false, false);
  }
  return result('up-to-date', false, false);
}

/**
 * Runs the migration status check according to the active policy.
 *
 * @returns {Promise<{
 *   policy: 'strict'|'warn'|'off',
 *   status: string,
 *   pending: boolean,
 *   drift: boolean,
 *   skipped: boolean,
 *   output: string,
 * }>}
 */
async function checkMigrations() {
  const policy = currentPolicy();

  if (policy === 'off') {
    return { policy, status: 'skipped', pending: false, drift: false, skipped: true, output: '' };
  }

  if (!process.env.DATABASE_URL) {
    // Nothing to compare against; don't block local/dev/mock startup but do
    // say so, since it often indicates a misconfigured environment.
    logger.warn(
      '[migrate-check] DATABASE_URL is not set — skipping migration status check'
    );
    return { policy, status: 'skipped', pending: false, drift: false, skipped: true, output: '' };
  }

  // Checksum manifest comparison is read-only and independent of the CLI, so
  // run it first; a failure here must never block startup.
  let schemaReport = null;
  try {
    schemaReport = getSchemaReport();
  } catch (err) {
    logger.warn(err, '[migrate-check] Could not compute migration checksum manifest');
  }

  let raw;
  try {
    raw = await runMigrateStatus();
  } catch (err) {
    // The CLI itself failed to spawn (missing binary, EACCES...). Do not block
    // startup but surface it so operators can investigate.
    logger.warn(err, '[migrate-check] Could not run "prisma migrate status" — skipping check');
    return {
      policy,
      status: 'error',
      pending: false,
      drift: false,
      skipped: true,
      output: err.message,
      schemaReport,
    };
  }

  const classified = classifyStatus(raw);
  // Fold checksum drift into the CLI classification so a changed historical
  // migration is treated exactly like schema drift.
  const checksumDrift = Boolean(schemaReport && schemaReport.drift);
  return {
    policy,
    ...classified,
    drift: classified.drift || checksumDrift,
    skipped: false,
    schemaReport,
  };
}

/**
 * Logs the result of the check and decides whether startup should abort.
 *
 * @param {ReturnType<typeof checkMigrations> extends Promise<infer T> ? T : never} result
 * @returns {{ shouldExit: boolean }}
 */
function enforceMigrationPolicy(result) {
  const { policy, status, pending, skipped, output, schemaReport } = result;

  if (skipped) {
    return { shouldExit: false };
  }

  const trimmed = (output || '').trim();

  // Surface the deployed schema version and any checksum drift regardless of
  // the CLI classification.
  if (schemaReport) {
    const version = schemaReport.schemaVersion || '(none recorded)';
    if (schemaReport.drift) {
      const details = [];
      if (schemaReport.changed.length) {
        details.push(`changed: ${schemaReport.changed.join(', ')}`);
      }
      if (schemaReport.missing.length) {
        details.push(`missing: ${schemaReport.missing.join(', ')}`);
      }
      logger.warn(
        `[migrate-check] Migration checksum drift detected (schema version ${version}). ` +
          `Historical migration files no longer match the manifest — ${details.join('; ')}.`
      );
    } else {
      logger.info(`[migrate-check] Deployed schema version: ${version}.`);
    }
  }

  if (status === 'up-to-date' && !(schemaReport && schemaReport.drift)) {
    logger.info('[migrate-check] Prisma migrations are up to date.');
    return { shouldExit: false };
  }

  if (status === 'pending' || status === 'drift') {
    const reason = pending
      ? 'there are pending migrations that have not been applied'
      : 'the database schema has drifted from the local migrations';
    const message = [
      '[migrate-check] Database schema is out of sync with Prisma migrations.',
      `Cause: ${reason}.`,
      '',
      'Queries are likely to fail with cryptic Prisma errors (P2010 / P2021 / no such column).',
      'Run "npx prisma migrate deploy" (production/CI) or "npx prisma migrate dev" (development)',
      'to bring the database up to date, then restart the server.',
      '',
      'Raw "prisma migrate status" output:',
      trimmed || '(no output)',
    ].join('\n');

    if (policy === 'strict') {
      logger.error(message);
      return { shouldExit: true };
    }
    logger.warn(message);
    return { shouldExit: false };
  }

  // 'unknown' / 'error' — log the raw output as a warning but keep booting so
  // an unexpected CLI response never takes a healthy environment down.
  logger.warn(
    `[migrate-check] Could not determine migration status (${status}). ` +
      `Raw output:\n${trimmed || '(no output)'}`
  );
  return { shouldExit: false };
}

/**
 * Flushes any buffered log output before the process terminates.
 *
 * Under MIGRATION_POLICY=strict we exit non-zero on drift/pending migrations.
 * In some environments (PM2, Docker with `restart: always`) the process is
 * torn down before the buffered error line reaches disk, producing silent
 * restart loops. Awaiting this helper guarantees the log is written first.
 *
 * Supports both a promise-returning `logger.flush()` and a transport that
 * emits a 'finish' event. Resolves (never rejects) so a flush failure can
 * never mask the intended non-zero exit.
 *
 * @returns {Promise<void>}
 */
function flushLogs() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Safety net: never hang startup on a stuck transport.
    const timer = setTimeout(done, 5_000);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      if (logger && typeof logger.flush === 'function') {
        const result = logger.flush();
        if (result && typeof result.then === 'function') {
          result.then(() => {
            clearTimeout(timer);
            done();
          }, () => {
            clearTimeout(timer);
            done();
          });
          return;
        }
        clearTimeout(timer);
        done();
        return;
      }

      const transport = logger && (logger.transport || logger._transport);
      if (transport && typeof transport.once === 'function') {
        transport.once('finish', () => {
          clearTimeout(timer);
          done();
        });
        if (typeof transport.end === 'function') transport.end();
        return;
      }
    } catch (_err) {
      // Fall through to resolve; flushing must never block the exit.
    }

    clearTimeout(timer);
    done();
  });
}

module.exports = {
  checkMigrations,
  enforceMigrationPolicy,
  currentPolicy,
  classifyStatus,
  runMigrateStatus,
  flushLogs,
  sha256,
  computeMigrationChecksums,
  loadManifest,
  saveManifest,
  compareManifest,
  getSchemaReport,
  PRISMA_BIN,
  MIGRATIONS_DIR,
  MANIFEST_PATH,
};