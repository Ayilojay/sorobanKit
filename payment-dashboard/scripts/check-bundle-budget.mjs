#!/usr/bin/env node
/**
 * Bundle budget checker for payment-dashboard.
 *
 * Measures per-route JavaScript chunk sizes (initial + gzip) for the
 * registration, history, analytics, and help routes, compares them against
 * the checked-in budget config (scripts/bundle-budget.json), and fails CI
 * when a budget is exceeded unless the budget file is updated in the same
 * change.
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs [options]
 *
 * Options:
 *   --manifest <path>   Path to dist/.vite/manifest.json (default: dist/.vite/manifest.json)
 *   --dist <path>       Path to the dist directory (default: dist)
 *   --budget <path>     Path to budget config (default: scripts/bundle-budget.json)
 *   --stats <path>      Path to rollup-plugin-visualizer JSON output (default: dist/bundle-stats.json)
 *   --base-ref <ref>    Git ref to diff against for budget-file changes (default: origin/main)
 *   --json              Emit machine-readable JSON report to stdout
 *   --no-build          Skip running the production build
 *   --help              Show this help
 *
 * Exit codes:
 *   0  All budgets satisfied (or budget file updated in same change)
 *   1  Budget regression detected
 *   2  Configuration / IO error
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

export const ROUTES = ['registration', 'history', 'analytics', 'help'];

const DEFAULT_OPTIONS = {
  manifest: join(ROOT, 'dist', '.vite', 'manifest.json'),
  dist: join(ROOT, 'dist'),
  budget: join(ROOT, 'scripts', 'bundle-budget.json'),
  stats: join(ROOT, 'dist', 'bundle-stats.json'),
  baseRef: process.env.BUNDLE_BUDGET_BASE_REF || 'origin/main',
  json: false,
  build: true,
};

/**
 * Parse CLI args into an options object.
 * @param {string[]} argv
 * @returns {typeof DEFAULT_OPTIONS & { help?: boolean }}
 */
export function parseArgs(argv) {
  const opts = { ...DEFAULT_OPTIONS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--manifest':
        opts.manifest = resolve(ROOT, argv[++i]);
        break;
      case '--dist':
        opts.dist = resolve(ROOT, argv[++i]);
        break;
      case '--budget':
        opts.budget = resolve(ROOT, argv[++i]);
        break;
      case '--stats':
        opts.stats = resolve(ROOT, argv[++i]);
        break;
      case '--base-ref':
        opts.baseRef = argv[++i];
        break;
      case '--json':
        opts.json = true;
        break;
      case '--no-build':
        opts.build = false;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }
  return opts;
}

/**
 * Resolve the set of chunk files that make up a route's initial load.
 * Follows `imports` (static) but not `dynamicImports` (lazy) so we measure
 * the initial payload for the route entry.
 *
 * @param {Record<string, any>} manifest Vite manifest keyed by source path
 * @param {string} entryKey Manifest key for the route entry
 * @returns {string[]} Unique list of emitted file paths (relative to dist)
 */
export function collectInitialFiles(manifest, entryKey) {
  const seen = new Set();
  const files = [];
  const visit = (key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    const entry = manifest[key];
    if (!entry) return;
    if (entry.file && !files.includes(entry.file)) {
      files.push(entry.file);
    }
    for (const css of entry.css || []) {
      if (!files.includes(css)) files.push(css);
    }
    for (const imp of entry.imports || []) {
      visit(imp);
    }
  };
  visit(entryKey);
  return files;
}

/**
 * Find the manifest key for a route. Routes are matched by source path
 * containing `/routes/<name>/` or `/routes/<name>.` (case-insensitive).
 *
 * @param {Record<string, any>} manifest
 * @param {string} route
 * @returns {string | null}
 */
export function findRouteEntry(manifest, route) {
  const needle = `/routes/${route.toLowerCase()}`;
  const candidates = Object.keys(manifest).filter((key) => {
    const lower = key.toLowerCase();
    return lower.includes(needle) && manifest[key]?.isEntry;
  });
  if (candidates.length === 0) {
    // Fall back to any matching key (non-entry) if no explicit entry.
    const any = Object.keys(manifest).filter((key) =>
      key.toLowerCase().includes(needle),
    );
    return any.length > 0 ? any[0] : null;
  }
  // Prefer the shortest key (most likely the route entry itself).
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

/**
 * Compute raw and gzip byte sizes for a list of files.
 *
 * @param {string} distDir
 * @param {string[]} files
 * @returns {{ raw: number, gzip: number, perFile: Array<{ file: string, raw: number, gzip: number }> }}
 */
export function measureFiles(distDir, files) {
  let raw = 0;
  let gzip = 0;
  const perFile = [];
  for (const file of files) {
    const full = isAbsolute(file) ? file : join(distDir, file);
    if (!existsSync(full)) continue;
    const buf = readFileSync(full);
    const gz = gzipSync(buf, { level: 9 }).length;
    raw += buf.length;
    gzip += gz;
    perFile.push({ file, raw: buf.length, gzip: gz });
  }
  return { raw, gzip, perFile };
}

/**
 * Compare measured sizes against budgets.
 *
 * @param {Record<string, { raw: number, gzip: number }>} measured
 * @param {Record<string, { initial: number, gzip: number }>} budgets
 * @returns {{ ok: boolean, violations: Array<{ route: string, metric: 'initial'|'gzip', actual: number, budget: number, overBy: number }> }}
 */
export function compareBudgets(measured, budgets) {
  const violations = [];
  for (const route of Object.keys(budgets)) {
    const budget = budgets[route];
    const actual = measured[route];
    if (!actual) {
      violations.push({
        route,
        metric: 'initial',
        actual: 0,
        budget: budget.initial,
        overBy: 0,
        missing: true,
      });
      continue;
    }
    if (typeof budget.initial === 'number' && actual.raw > budget.initial) {
      violations.push({
        route,
        metric: 'initial',
        actual: actual.raw,
        budget: budget.initial,
        overBy: actual.raw - budget.initial,
      });
    }
    if (typeof budget.gzip === 'number' && actual.gzip > budget.gzip) {
      violations.push({
        route,
        metric: 'gzip',
        actual: actual.gzip,
        budget: budget.gzip,
        overBy: actual.gzip - budget.gzip,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Determine whether the budget file was modified in the current change
 * relative to the base ref. Returns true if git is unavailable or the
 * comparison cannot be made (fail-open on the "approved" check so that
 * local runs are not blocked, but CI will still fail on violations).
 *
 * @param {string} budgetPath
 * @param {string} baseRef
 * @returns {boolean}
 */
export function budgetFileUpdated(budgetPath, baseRef) {
  try {
    const rel = budgetPath.startsWith(ROOT)
      ? budgetPath.slice(ROOT.length + 1)
      : budgetPath;
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `${baseRef}...HEAD`, '--', rel],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (out.trim().length > 0) return true;
    // Also consider uncommitted changes (working tree / index).
    const status = execFileSync('git', ['status', '--porcelain', '--', rel], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract offending modules for a route from rollup-plugin-visualizer JSON.
 * The visualizer emits a tree of nodes with `name` and `value` (bytes).
 *
 * @param {any} stats Parsed visualizer JSON
 * @param {string} route
 * @param {number} [limit]
 * @returns {Array<{ name: string, bytes: number }>}
 */
export function offendingModules(stats, route, limit = 10) {
  if (!stats) return [];
  const needle = `/routes/${route.toLowerCase()}`;
  const modules = [];

  const walk = (node, inRoute) => {
    if (!node || typeof node !== 'object') return;
    const name = typeof node.name === 'string' ? node.name : '';
    const isRoute = inRoute || name.toLowerCase().includes(needle);
    if (isRoute && typeof node.value === 'number' && node.value > 0) {
      modules.push({ name: name || '(anonymous)', bytes: node.value });
    }
    const children = node.children || node.groups || [];
    if (Array.isArray(children)) {
      for (const child of children) walk(child, isRoute);
    }
  };

  if (Array.isArray(stats)) {
    for (const node of stats) walk(node, false);
  } else {
    walk(stats, false);
  }

  // Deduplicate by name, keep largest.
  const byName = new Map();
  for (const m of modules) {
    const prev = byName.get(m.name);
    if (!prev || prev.bytes < m.bytes) byName.set(m.name, m);
  }
  return [...byName.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/**
 * Format bytes for human-readable output.
 * @param {number} n
 */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Run the production build.
 */
function runBuild() {
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, BUNDLE_BUDGET_STATS: '1' },
  });
}

/**
 * Main entry point.
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }

  if (opts.help) {
    console.log(
      'Usage: node scripts/check-bundle-budget.mjs [--manifest <p>] [--dist <p>] [--budget <p>] [--stats <p>] [--base-ref <ref>] [--json] [--no-build]',
    );
    return 0;
  }

  if (opts.build) {
    try {
      runBuild();
    } catch (err) {
      console.error(`error: production build failed: ${err.message}`);
      return 2;
    }
  }

  if (!existsSync(opts.manifest)) {
    console.error(`error: manifest not found at ${opts.manifest}`);
    return 2;
  }
  if (!existsSync(opts.budget)) {
    console.error(`error: budget config not found at ${opts.budget}`);
    return 2;
  }

  let manifest;
  let budgets;
  try {
    manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
    budgets = JSON.parse(readFileSync(opts.budget, 'utf8'));
  } catch (err) {
    console.error(`error: failed to parse config: ${err.message}`);
    return 2;
  }

  const routeBudgets = budgets.routes || budgets;
  const measured = {};
  const missingRoutes = [];

  for (const route of ROUTES) {
    const entryKey = findRouteEntry(manifest, route);
    if (!entryKey) {
      missingRoutes.push(route);
      continue;
    }
    const files = collectInitialFiles(manifest, entryKey);
    measured[route] = measureFiles(opts.dist, files);
  }

  const { ok, violations } = compareBudgets(measured, routeBudgets);

  let stats = null;
  if (!ok && existsSync(opts.stats)) {
    try {
      stats = JSON.parse(readFileSync(opts.stats, 'utf8'));
    } catch {
      stats = null;
    }
  }

  const budgetUpdated = !ok && budgetFileUpdated(opts.budget, opts.baseRef);

  const report = {
    ok: ok || budgetUpdated,
    budgetUpdated,
    missingRoutes,
    measured: Object.fromEntries(
      Object.entries(measured).map(([route, m]) => [
        route,
        { raw: m.raw, gzip: m.gzip, files: m.perFile },
      ]),
    ),
    violations,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, stats);
  }

  if (ok) return 0;
  if (budgetUpdated) {
    if (!opts.json) {
      console.log(
        '\nBudget file was updated in this change; treating regression as approved.',
      );
    }
    return 0;
  }
  return 1;
}

/**
 * Print a human-readable report.
 * @param {any} report
 * @param {any} stats
 */
function printHumanReport(report, stats) {
  console.log('Bundle budget report');
  console.log('====================');
  for (const route of ROUTES) {
    const m = report.measured[route];
    if (!m) {
      console.log(`  ${route.padEnd(12)} MISSING (no manifest entry)`);
      continue;
    }
    console.log(
      `  ${route.padEnd(12)} initial=${formatBytes(m.raw).padStart(10)}  gzip=${formatBytes(m.gzip).padStart(10)}`,
    );
  }

  if (report.violations.length === 0) {
    console.log('\nAll budgets satisfied.');
    return;
  }

  console.log('\nBudget violations:');
  for (const v of report.violations) {
    if (v.missing) {
      console.log(`  ${v.route}: no chunk found in manifest`);
      continue;
    }
    console.log(
      `  ${v.route} ${v.metric}: ${formatBytes(v.actual)} exceeds budget ${formatBytes(v.budget)} by ${formatBytes(v.overBy)}`,
    );
    if (stats) {
      const offenders = offendingModules(stats, v.route);
      if (offenders.length > 0) {
        console.log('    Top offending modules:');
        for (const mod of offenders) {
          console.log(`      ${formatBytes(mod.bytes).padStart(10)}  ${mod.name}`);
        }
      }
    }
  }

  if (report.budgetUpdated) {
    console.log(
      '\nBudget file was updated in this change; treating regression as approved.',
    );
  } else {
    console.log(
      '\nUpdate scripts/bundle-budget.json in this change to approve the new budget, or reduce bundle size.',
    );
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  process.exit(main());
}