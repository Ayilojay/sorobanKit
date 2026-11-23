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

// ---------------------------------------------------------------------------
// Compatibility preflight (issue #469)
// ---------------------------------------------------------------------------
// Before a candidate migration is deployed we want to know whether it is safe
// to run while old application replicas are still serving traffic. The
// preflight:
//   1. Parses the candidate migration SQL into individual statements.
//   2. Classifies each statement as destructive (contract phase) or
//      non-destructive (expand phase).
//   3. Checks the candidate against the old and new application schema
//      snapshots to report incompatible statements.
//   4. Requires an explicit replica-drain marker/flag before destructive
//      contract phases are allowed to proceed.
//   5. Emits a machine-readable report so CI can fail before deployment.
//
// The startup status check above is untouched; these helpers are additive and
// exported for focused tests.
// ---------------------------------------------------------------------------

/** Environment flag that signals all old replicas have been drained. */
const REPLICA_DRAIN_ENV = 'MIGRATION_REPLICAS_DRAINED';

/** Marker file (relative to the project root) recording a completed drain. */
const REPLICA_DRAIN_MARKER = path.join(PROJECT_ROOT, '.migration-replicas-drained');

/**
 * Statement kinds that can break old replicas still running the previous
 * application version. These are the "contract" phase of an expand/contract
 * migration and must only run after old replicas are drained.
 */
const DESTRUCTIVE_PATTERNS = [
  { kind: 'drop-table', re: /^\s*drop\s+table\b/i },
  { kind: 'drop-column', re: /^\s*alter\s+table\b[\s\S]*\bdrop\s+column\b/i },
  { kind: 'rename-column', re: /^\s*alter\s+table\b[\s\S]*\brename\s+column\b/i },
  { kind: 'rename-table', re: /^\s*alter\s+table\b[\s\S]*\brename\s+to\b/i },
  { kind: 'drop-constraint', re: /^\s*alter\s+table\b[\s\S]*\bdrop\s+constraint\b/i },
  { kind: 'drop-index', re: /^\s*drop\s+index\b/i },
  { kind: 'truncate', re: /^\s*truncate\b/i },
  { kind: 'set-not-null', re: /^\s*alter\s+table\b[\s\S]*\bset\s+not\s+null\b/i },
  { kind: 'alter-type', re: /^\s*alter\s+table\b[\s\S]*\balter\s+column\b[\s\S]*\btype\b/i },
];

/**
 * Splits a migration SQL file into individual statements.
 *
 * Handles `--` line comments, `/* ... *\/` block comments, single-quoted
 * string literals (with `''` escapes) and dollar-quoted bodies so that a `;`
 * inside any of those does not split a statement. Empty statements are
 * dropped.
 *
 * @param {string} sql
 * @returns {string[]}
 */
function parseMigrationStatements(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return [];

  const statements = [];
  let current = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment.
    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') i += 1;
      current += ' ';
      continue;
    }

    // Block comment.
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      current += ' ';
      continue;
    }

    // Single-quoted string literal.
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < len) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Dollar-quoted string ($$ ... $$ or $tag$ ... $tag$).
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
          continue;
        }
      }
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Classifies a single SQL statement as destructive or not.
 *
 * @param {string} statement
 * @returns {{ statement: string, destructive: boolean, kind: string }}
 */
function classifyStatement(statement) {
  const text = (statement || '').trim();
  for (const { kind, re } of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) {
      return { statement: text, destructive: true, kind };
    }
  }
  return { statement: text, destructive: false, kind: 'non-destructive' };
}

/**
 * Classifies every statement in a migration SQL string.
 *
 * @param {string} sql
 * @returns {{ statements: Array<{statement: string, destructive: boolean, kind: string}>, destructive: boolean, destructiveKinds: string[] }}
 */
function classifyMigration(sql) {
  const statements = parseMigrationStatements(sql).map(classifyStatement);
  const destructiveKinds = statements
    .filter((s) => s.destructive)
    .map((s) => s.kind);
  return {
    statements,
    destructive: destructiveKinds.length > 0,
    destructiveKinds,
  };
}

/**
 * Normalises a schema snapshot into a set of `table.column` keys.
 *
 * Accepts either:
 *   - an object: { users: ['id', 'email'], ... }
 *   - an array of { table, columns: [...] } entries
 *   - a raw Prisma schema string (best-effort `model`/field parsing)
 *
 * @param {object|Array|string} snapshot
 * @returns {Set<string>}
 */
function normaliseSnapshot(snapshot) {
  const keys = new Set();
  if (!snapshot) return keys;

  const addTable = (table, columns) => {
    if (!table) return;
    keys.add(String(table));
    for (const column of columns || []) {
      keys.add(`${table}.${column}`);
    }
  };

  if (typeof snapshot === 'string') {
    // Best-effort Prisma schema parsing: `model Name { field Type ... }`.
    const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let match;
    while ((match = modelRe.exec(snapshot)) !== null) {
      const table = match[1];
      const body = match[2];
      const columns = [];
      for (const line of body.split('\n')) {
        const fieldMatch = /^\s*(\w+)\s+\w+/.exec(line);
        if (fieldMatch) columns.push(fieldMatch[1]);
      }
      addTable(table, columns);
    }
    return keys;
  }

  if (Array.isArray(snapshot)) {
    for (const entry of snapshot) {
      if (!entry) continue;
      addTable(entry.table || entry.name, entry.columns || entry.fields);
    }
    return keys;
  }

  if (typeof snapshot === 'object') {
    for (const [table, columns] of Object.entries(snapshot)) {
      addTable(table, Array.isArray(columns) ? columns : []);
    }
  }
  return keys;
}

/**
 * Extracts the tables/columns a migration statement touches so it can be
 * checked against a schema snapshot.
 *
 * @param {string} statement
 * @returns {{ tables: string[], columns: string[] }}
 */
function extractTouchedObjects(statement) {
  const text = statement || '';
  const tables = [];
  const columns = [];

  const tableRe = /\b(?:alter\s+table|drop\s+table|create\s+table|truncate(?:\s+table)?|drop\s+index\s+\w+\s+on|create\s+(?:unique\s+)?index\s+\w+\s+on)\s+(?:if\s+exists\s+)?["`]?(\w+)["`]?/gi;
  let match;
  while ((match = tableRe.exec(text)) !== null) {
    tables.push(match[1]);
  }

  const columnRe = /\b(?:drop\s+column|add\s+column|alter\s+column|rename\s+column)\s+(?:if\s+exists\s+)?["`]?(\w+)["`]?/gi;
  while ((match = columnRe.exec(text)) !== null) {
    columns.push(match[1]);
  }

  return { tables, columns };
}

/**
 * Checks a candidate migration against the old and new application schema
 * snapshots and reports incompatible statements.
 *
 * A statement is incompatible when it references an object that does not
 * exist in the snapshot it must be compatible with:
 *   - destructive statements must be valid against the OLD snapshot (they
 *     remove things old code still uses, so the object must exist), and
 *   - non-destructive statements must be valid against the NEW snapshot.
 *
 * @param {string} sql Candidate migration SQL.
 * @param {{ oldSchema?: object|Array|string, newSchema?: object|Array|string }} snapshots
 * @returns {{ compatible: boolean, incompatible: Array<{statement: string, kind: string, reason: string}>, statements: Array<object> }}
 */
function checkCompatibility(sql, snapshots = {}) {
  const oldKeys = normaliseSnapshot(snapshots.oldSchema);
  const newKeys = normaliseSnapshot(snapshots.newSchema);
  const { statements } = classifyMigration(sql);
  const incompatible = [];

  for (const entry of statements) {
    const { tables, columns } = extractTouchedObjects(entry.statement);
    const targetKeys = entry.destructive ? oldKeys : newKeys;
    const targetLabel = entry.destructive ? 'old' : 'new';

    // Only validate when we actually have a snapshot to compare against.
    if (targetKeys.size === 0) continue;

    for (const table of tables) {
      if (!targetKeys.has(table)) {
        incompatible.push({
          statement: entry.statement,
          kind: entry.kind,
          reason: `references table "${table}" missing from the ${targetLabel} schema snapshot`,
        });
      }
    }
    for (const column of columns) {
      const qualified = tables.length > 0 ? `${tables[0]}.${column}` : null;
      if (qualified && !targetKeys.has(qualified)) {
        incompatible.push({
          statement: entry.statement,
          kind: entry.kind,
          reason: `references column "${qualified}" missing from the ${targetLabel} schema snapshot`,
        });
      }
    }
  }

  return {
    compatible: incompatible.length === 0,
    incompatible,
    statements,
  };
}

/**
 * Determines whether old replicas have been drained.
 *
 * A drain is signalled by either the MIGRATION_REPLICAS_DRAINED env flag
 * (truthy string) or the presence of the drain marker file.
 *
 * @param {{ env?: object, markerPath?: string, existsSync?: Function }} [options]
 * @returns {{ drained: boolean, source: string }}
 */
function isReplicaDrainConfirmed(options = {}) {
  const env = options.env || process.env;
  const markerPath = options.markerPath || REPLICA_DRAIN_MARKER;
  const existsSync = options.existsSync || fs.existsSync;

  const flag = String(env[REPLICA_DRAIN_ENV] || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(flag)) {
    return { drained: true, source: 'env' };
  }

  try {
    if (existsSync(markerPath)) {
      return { drained: true, source: 'marker' };
    }
  } catch (_err) {
    // Treat an unreadable marker as "not drained" — fail closed.
  }

  return { drained: false, source: 'none' };
}

/**
 * Runs the full compatibility preflight for a candidate migration.
 *
 * @param {object} params
 * @param {string} params.sql Candidate migration SQL.
 * @param {object|Array|string} [params.oldSchema] Old application schema snapshot.
 * @param {object|Array|string} [params.newSchema] New application schema snapshot.
 * @param {object} [params.env] Environment to read the drain flag from.
 * @param {string} [params.markerPath] Drain marker path override.
 * @param {Function} [params.existsSync] fs.existsSync override (for tests).
 * @returns {{
 *   ok: boolean,
 *   destructive: boolean,
 *   destructiveKinds: string[],
 *   compatible: boolean,
 *   incompatible: Array<object>,
 *   drain: { drained: boolean, source: string },
 *   blocked: boolean,
 *   reasons: string[],
 *   report: string,
 * }}
 */
function runCompatibilityPreflight(params = {}) {
  const { sql = '', oldSchema, newSchema } = params;
  const classification = classifyMigration(sql);
  const compatibility = checkCompatibility(sql, { oldSchema, newSchema });
  const drain = isReplicaDrainConfirmed({
    env: params.env,
    markerPath: params.markerPath,
    existsSync: params.existsSync,
  });

  const reasons = [];

  if (!compatibility.compatible) {
    for (const item of compatibility.incompatible) {
      reasons.push(`incompatible statement (${item.kind}): ${item.reason}`);
    }
  }

  // Destructive contract phases must wait until old replicas are drained.
  const blocked = classification.destructive && !drain.drained;
  if (blocked) {
    reasons.push(
      `destructive contract phase (${classification.destructiveKinds.join(', ')}) ` +
        `requires old replicas to be drained; set ${REPLICA_DRAIN_ENV}=true or create ` +
        `${path.basename(REPLICA_DRAIN_MARKER)} after draining`,
    );
  }

  const ok = compatibility.compatible && !blocked;

  const reportLines = [
    '[migrate-preflight] Candidate migration compatibility report',
    `  statements: ${classification.statements.length}`,
    `  destructive: ${classification.destructive ? classification.destructiveKinds.join(', ') : 'none'}`,
    `  compatible: ${compatibility.compatible}`,
    `  replicas drained: ${drain.drained} (${drain.source})`,
    `  result: ${ok ? 'PASS' : 'BLOCKED'}`,
  ];
  if (reasons.length > 0) {
    reportLines.push('  reasons:');
    for (const reason of reasons) reportLines.push(`    - ${reason}`);
  }

  return {
    ok,
    destructive: classification.destructive,
    destructiveKinds: classification.destructiveKinds,
    compatible: compatibility.compatible,
    incompatible: compatibility.incompatible,
    drain,
    blocked,
    reasons,
    report: reportLines.join('\n'),
  };
}

/**
 * Reads a candidate migration SQL file and runs the compatibility preflight.
 *
 * @param {string} filePath
 * @param {object} [params] Same options as runCompatibilityPreflight.
 * @returns {ReturnType<typeof runCompatibilityPreflight>}
 */
function preflightMigrationFile(filePath, params = {}) {
  const sql = fs.readFileSync(filePath, 'utf8');
  return runCompatibilityPreflight({ ...params, sql });
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

module.exports = {
  checkMigrations,
  enforceMigrationPolicy,
  currentPolicy,
  classifyStatus,
  runMigrateStatus,
  flushLogs,
  PRISMA_BIN,
  // Compatibility preflight (issue #469)
  parseMigrationStatements,
  classifyStatement,
  classifyMigration,
  normaliseSnapshot,
  extractTouchedObjects,
  checkCompatibility,
  isReplicaDrainConfirmed,
  runCompatibilityPreflight,
  preflightMigrationFile,
  REPLICA_DRAIN_ENV,
  REPLICA_DRAIN_MARKER,
  DESTRUCTIVE_PATTERNS,
};