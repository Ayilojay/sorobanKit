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
const fs = require('fs');
const path = require('path');

const { logger } = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '..');
const PRISMA_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'prisma');

/** How long to wait for `prisma migrate status` before giving up. */
const MIGRATION_CHECK_TIMEOUT_MS =
  parseInt(process.env.MIGRATION_CHECK_TIMEOUT_MS, 10) || 30_000;

const POLICIES = new Set(['strict', 'warn', 'off']);

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

  let raw;
  try {
    raw = await runMigrateStatus();
  } catch (err) {
    // The CLI itself failed to spawn (missing binary, EACCES...). Do not block
    // startup but surface it so operators can investigate.
    logger.warn(err, '[migrate-check] Could not run "prisma migrate status" — skipping check');
    return { policy, status: 'error', pending: false, drift: false, skipped: true, output: err.message };
  }

  return { policy, ...classifyStatus(raw), skipped: false };
}

/**
 * Logs the result of the check and decides whether startup should abort.
 *
 * @param {ReturnType<typeof checkMigrations> extends Promise<infer T> ? T : never} result
 * @returns {{ shouldExit: boolean }}
 */
function enforceMigrationPolicy(result) {
  const { policy, status, pending, skipped, output } = result;

  if (skipped) {
    return { shouldExit: false };
  }

  const trimmed = (output || '').trim();

  if (status === 'up-to-date') {
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

// ---------------------------------------------------------------------------
// Migration SQL lint (expand / contract guard)
// ---------------------------------------------------------------------------
// Enforces the expand-contract migration discipline so rolling deploys stay
// zero-downtime:
//
//   expand    -> additive, backwards-compatible changes (add nullable column,
//                add index, backfill UPDATE). Always allowed.
//   contract  -> destructive changes (DROP COLUMN, DROP TABLE, narrowing a
//                column type, ADD COLUMN ... NOT NULL without a DEFAULT).
//                Rejected unless explicitly allowed, because old instances
//                still running during a rolling deploy would break.
//
// The lint is intentionally a lightweight SQL scanner, not a full parser: it
// strips comments and string literals, then matches the handful of statement
// shapes that matter for compatibility. It errs on the side of flagging.
// ---------------------------------------------------------------------------

/** Types considered "narrower" than their common predecessors. */
const NARROWING_TYPES = new Set([
  'smallint',
  'int2',
  'integer',
  'int',
  'int4',
  'bigint',
  'int8',
  'varchar',
  'character varying',
  'char',
  'character',
  'text',
  'date',
  'timestamp',
  'timestamptz',
  'timestamp with time zone',
  'timestamp without time zone',
  'real',
  'float4',
  'double precision',
  'float8',
  'numeric',
  'decimal',
  'boolean',
  'bool',
  'uuid',
]);

/**
 * Removes SQL line comments (`-- ...`), block comments (`/* ... *\/`) and
 * single-quoted string literals so keyword matching is not fooled by content
 * inside them. String literals are replaced with a placeholder.
 * @param {string} sql
 * @returns {string}
 */
function stripSqlNoise(sql) {
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += "''";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Splits a SQL script into individual statements on top-level semicolons.
 * @param {string} sql
 * @returns {string[]}
 */
function splitStatements(sql) {
  return stripSqlNoise(sql)
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

/**
 * Normalises a SQL type expression for comparison.
 * @param {string} raw
 * @returns {string}
 */
function normalizeType(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lints a single migration SQL statement.
 * @param {string} statement
 * @param {{ allowDestructive?: boolean }} [options]
 * @returns {Array<{ rule: string, message: string, statement: string }>}
 */
function lintStatement(statement, options = {}) {
  const allowDestructive = Boolean(options.allowDestructive);
  const findings = [];
  const normalized = statement.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  const add = (rule, message) => {
    if (allowDestructive) return;
    findings.push({ rule, message, statement: normalized });
  };

  // DROP TABLE
  if (/^drop\s+table\b/.test(lower)) {
    add(
      'drop-table',
      'DROP TABLE is destructive; use the contract phase after all code stops reading the table.'
    );
    return findings;
  }

  // DROP COLUMN (also covers ALTER TABLE ... DROP COLUMN)
  if (/\bdrop\s+column\b/.test(lower)) {
    add(
      'drop-column',
      'DROP COLUMN is destructive; move it to the contract phase once no code references the column.'
    );
    return findings;
  }

  // ALTER COLUMN ... TYPE <narrower>
  const alterType = lower.match(
    /\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\s+([a-z0-9_ ]+?)(?:\s+using\b|$|\s+(?:not|null|default)\b)/
  );
  if (alterType) {
    const target = normalizeType(alterType[1]);
    if (NARROWING_TYPES.has(target)) {
      add(
        'narrowing-type',
        `ALTER COLUMN ... TYPE ${target} may narrow the column and break old readers; add a new column and backfill instead.`
      );
    }
  }

  // ADD COLUMN ... NOT NULL without DEFAULT
  const addColumn = lower.match(/\badd\s+column\s+(?:if\s+not\s+exists\s+)?\S+/);
  if (addColumn) {
    const hasNotNull = /\bnot\s+null\b/.test(lower);
    const hasDefault = /\bdefault\b/.test(lower);
    if (hasNotNull && !hasDefault) {
      add(
        'add-not-null-without-default',
        'ADD COLUMN ... NOT NULL without DEFAULT fails on non-empty tables and breaks old writers; add it nullable, backfill, then enforce NOT NULL in the contract phase.'
      );
    }
  }

  return findings;
}

/**
 * Lints a migration SQL script.
 *
 * @param {string} sql Raw migration SQL.
 * @param {{ allowDestructive?: boolean }} [options]
 * @returns {{ ok: boolean, findings: Array<{ rule: string, message: string, statement: string }> }}
 */
function lintMigrationSql(sql, options = {}) {
  const findings = [];
  for (const statement of splitStatements(sql || '')) {
    findings.push(...lintStatement(statement, options));
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Lints every `*.sql` file in a directory (non-recursive).
 * @param {string} dir
 * @param {{ allowDestructive?: boolean }} [options]
 * @returns {{ ok: boolean, findings: Array<{ file: string, rule: string, message: string, statement: string }> }}
 */
function lintMigrationDir(dir, options = {}) {
  const findings = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return {
      ok: false,
      findings: [
        {
          file: dir,
          rule: 'read-error',
          message: `Could not read migration directory: ${err.message}`,
          statement: '',
        },
      ],
    };
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  for (const name of files) {
    const fullPath = path.join(dir, name);
    let sql;
    try {
      sql = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      findings.push({
        file: name,
        rule: 'read-error',
        message: `Could not read migration file: ${err.message}`,
        statement: '',
      });
      continue;
    }
    const result = lintMigrationSql(sql, options);
    for (const finding of result.findings) {
      findings.push({ file: name, ...finding });
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * CLI entry point for the migration lint.
 *
 * Usage:
 *   node src/migrate-check.js --lint <dir> [--allow-destructive]
 *
 * Exits 0 when clean, 1 when violations are found, 2 on usage errors.
 * @param {string[]} argv
 * @returns {number} process exit code
 */
function runLintCli(argv) {
  const args = argv.slice();
  const lintIndex = args.indexOf('--lint');
  if (lintIndex === -1) {
    process.stderr.write('Usage: node src/migrate-check.js --lint <dir> [--allow-destructive]\n');
    return 2;
  }

  const allowDestructive = args.includes('--allow-destructive');
  const dir = args[lintIndex + 1];
  if (!dir || dir.startsWith('--')) {
    process.stderr.write('Error: --lint requires a migration directory argument.\n');
    return 2;
  }

  const result = lintMigrationDir(dir, { allowDestructive });
  if (result.ok) {
    process.stdout.write(`[migrate-lint] ${dir}: no destructive changes detected.\n`);
    return 0;
  }

  process.stderr.write(
    `[migrate-lint] ${result.findings.length} destructive change(s) detected in ${dir}:\n`
  );
  for (const finding of result.findings) {
    process.stderr.write(`  - ${finding.file} [${finding.rule}] ${finding.message}\n`);
    if (finding.statement) {
      process.stderr.write(`      ${finding.statement}\n`);
    }
  }
  process.stderr.write(
    '\nSplit destructive changes into a separate contract-phase migration and re-run with --allow-destructive.\n'
  );
  return 1;
}

module.exports = {
  checkMigrations,
  enforceMigrationPolicy,
  currentPolicy,
  classifyStatus,
  runMigrateStatus,
  flushLogs,
  lintMigrationSql,
  lintMigrationDir,
  runLintCli,
  PRISMA_BIN,
};

// CLI entry: only run when invoked directly, so requiring this module from the
// server startup path keeps its existing behaviour untouched.
if (require.main === module) {
  process.exitCode = runLintCli(process.argv.slice(2));
}