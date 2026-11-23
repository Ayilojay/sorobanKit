#!/usr/bin/env node
/**
 * Detect changed workspaces and compute the set of CI jobs to run.
 *
 * Reads workspace manifests (package.json workspaces + pnpm-workspace.yaml),
 * builds a dependency graph between workspaces, maps changed file paths to
 * workspaces, and fans out to dependents when shared schemas, bindings, root
 * configuration, or lockfiles change. Falls back to a full-suite run when a
 * change cannot be confidently attributed to a workspace.
 *
 * Usage:
 *   node scripts/detect-changed-workspaces.mjs [options]
 *
 * Options:
 *   --base <ref>        Base git ref to diff against (default: origin/main)
 *   --head <ref>        Head git ref to diff against (default: HEAD)
 *   --changed <paths>   Comma-separated list of changed paths (skips git diff)
 *   --changed-file <f>  File containing newline-separated changed paths
 *   --root <dir>        Repository root (default: cwd)
 *   --dry-run           Print the plan without writing outputs
 *   --json              Print the plan as JSON to stdout
 *   --output <file>     Write the plan as JSON to the given file
 *   --github-output     Append outputs to $GITHUB_OUTPUT (if set)
 *   --help              Show this help
 *
 * Exit codes:
 *   0  Plan computed successfully
 *   1  Invalid arguments or unrecoverable error
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HELP = `Detect changed workspaces and compute CI jobs to run.

Options:
  --base <ref>        Base git ref to diff against (default: origin/main)
  --head <ref>        Head git ref to diff against (default: HEAD)
  --changed <paths>   Comma-separated list of changed paths (skips git diff)
  --changed-file <f>  File containing newline-separated changed paths
  --root <dir>        Repository root (default: cwd)
  --dry-run           Print the plan without writing outputs
  --json              Print the plan as JSON to stdout
  --output <file>     Write the plan as JSON to the given file
  --github-output     Append outputs to $GITHUB_OUTPUT (if set)
  --help              Show this help
`;

/**
 * Paths (relative to repo root) that, when changed, force a full-suite run.
 * These are shared schemas, bindings, root configuration, and lockfiles.
 */
const FULL_SUITE_PATTERNS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^yarn\.lock$/,
  /^package-lock\.json$/,
  /^lerna\.json$/,
  /^nx\.json$/,
  /^turbo\.json$/,
  /^tsconfig(\..+)?\.json$/,
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^scripts\//,
  /^schemas\//,
  /^bindings\//,
  /^shared\//,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^\.editorconfig$/,
  /^babel\.config\./,
  /^jest\.config\./,
  /^vitest\.config\./,
  /^rollup\.config\./,
  /^vite\.config\./,
  /^webpack\.config\./,
];

/**
 * Paths that are always ignored (never trigger a job).
 */
const IGNORE_PATTERNS = [
  /^\.git\//,
  /^node_modules\//,
  /\/node_modules\//,
  /^\.DS_Store$/,
  /\/\.DS_Store$/,
  /^docs\//,
  /^README(\..+)?$/i,
  /^LICENSE(\..+)?$/i,
  /^\.changeset\//,
  /^CHANGELOG\.md$/i,
];

function parseArgs(argv) {
  const opts = {
    base: 'origin/main',
    head: 'HEAD',
    changed: null,
    changedFile: null,
    root: process.cwd(),
    dryRun: false,
    json: false,
    output: null,
    githubOutput: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return v;
    };
    switch (arg) {
      case '--base':
        opts.base = next();
        break;
      case '--head':
        opts.head = next();
        break;
      case '--changed':
        opts.changed = next();
        break;
      case '--changed-file':
        opts.changedFile = next();
        break;
      case '--root':
        opts.root = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--output':
        opts.output = next();
        break;
      case '--github-output':
        opts.githubOutput = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Parse a minimal subset of pnpm-workspace.yaml to extract package globs.
 * Avoids a YAML dependency by handling the common `packages:` list form.
 */
function readPnpmWorkspaceGlobs(file) {
  const content = fs.readFileSync(file, 'utf8');
  const globs = [];
  let inPackages = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (m) {
        globs.push(m[1]);
      } else if (/^\S/.test(line)) {
        inPackages = false;
      }
    }
  }
  return globs;
}

/**
 * Convert a workspace glob (e.g. "packages/*") into a RegExp matching
 * workspace-relative directory paths.
 */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function listWorkspaceDirs(root, globs) {
  const regexes = globs.map(globToRegExp);
  const dirs = new Set();

  const walk = (relDir) => {
    const absDir = path.join(root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (regexes.some((r) => r.test(rel))) {
        if (fs.existsSync(path.join(root, rel, 'package.json'))) {
          dirs.add(rel);
        }
      }
      // Recurse to support nested globs like "packages/**".
      walk(rel);
    }
  };

  walk('');
  return [...dirs].sort();
}

function loadWorkspaces(root) {
  const rootPkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(rootPkgPath)) {
    throw new Error(`No package.json found at ${rootPkgPath}`);
  }
  const rootPkg = readJson(rootPkgPath);

  let globs = [];
  if (Array.isArray(rootPkg.workspaces)) {
    globs = rootPkg.workspaces;
  } else if (rootPkg.workspaces && Array.isArray(rootPkg.workspaces.packages)) {
    globs = rootPkg.workspaces.packages;
  }

  const pnpmPath = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    globs = globs.concat(readPnpmWorkspaceGlobs(pnpmPath));
  }

  globs = [...new Set(globs)];
  if (globs.length === 0) {
    return { rootPkg, workspaces: [] };
  }

  const dirs = listWorkspaceDirs(root, globs);
  const workspaces = dirs.map((dir) => {
    const pkg = readJson(path.join(root, dir, 'package.json'));
    return {
      dir,
      name: pkg.name || dir,
      pkg,
    };
  });

  return { rootPkg, workspaces };
}

/**
 * Build a map of workspace name -> set of workspace names it depends on
 * (internal dependencies only).
 */
function buildDependencyGraph(workspaces) {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const deps = new Map();

  for (const ws of workspaces) {
    const internal = new Set();
    const sections = [
      ws.pkg.dependencies,
      ws.pkg.devDependencies,
      ws.pkg.peerDependencies,
      ws.pkg.optionalDependencies,
    ];
    for (const section of sections) {
      if (!section) continue;
      for (const depName of Object.keys(section)) {
        if (byName.has(depName) && depName !== ws.name) {
          internal.add(depName);
        }
      }
    }
    deps.set(ws.name, internal);
  }

  return deps;
}

/**
 * Compute reverse dependency closure: given a set of changed workspace names,
 * return all workspaces that (transitively) depend on them.
 */
function computeDependents(changedNames, deps) {
  const reverse = new Map();
  for (const [name, internal] of deps) {
    for (const dep of internal) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(name);
    }
  }

  const result = new Set(changedNames);
  const queue = [...changedNames];
  while (queue.length > 0) {
    const current = queue.shift();
    const dependents = reverse.get(current);
    if (!dependents) continue;
    for (const d of dependents) {
      if (!result.has(d)) {
        result.add(d);
        queue.push(d);
      }
    }
  }
  return result;
}

function matchesAny(patterns, filePath) {
  return patterns.some((re) => re.test(filePath));
}

/**
 * Map a single changed path to a workspace directory, if any.
 */
function mapPathToWorkspace(filePath, workspaces) {
  // Longest-prefix match to handle nested workspaces.
  let best = null;
  for (const ws of workspaces) {
    if (filePath === ws.dir || filePath.startsWith(`${ws.dir}/`)) {
      if (!best || ws.dir.length > best.dir.length) {
        best = ws;
      }
    }
  }
  return best;
}

function getChangedPaths(opts) {
  if (opts.changed !== null) {
    return opts.changed
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (opts.changedFile) {
    return fs
      .readFileSync(opts.changedFile, 'utf8')
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', '--no-renames', `${opts.base}...${opts.head}`],
      { cwd: opts.root, encoding: 'utf8' },
    );
    return out
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  } catch (err) {
    throw new Error(
      `Failed to compute git diff between ${opts.base} and ${opts.head}: ${err.message}`,
    );
  }
}

/**
 * Compute the CI plan.
 *
 * Returns:
 *   {
 *     fullSuite: boolean,
 *     reason: string,
 *     changedPaths: string[],
 *     changedWorkspaces: string[],
 *     affectedWorkspaces: string[],
 *     jobs: string[],
 *   }
 */
function computePlan(opts) {
  const { workspaces } = loadWorkspaces(opts.root);
  const deps = buildDependencyGraph(workspaces);
  const allNames = workspaces.map((w) => w.name).sort();

  const changedPaths = getChangedPaths(opts);

  const relevant = changedPaths.filter(
    (p) => !matchesAny(IGNORE_PATTERNS, p),
  );

  if (relevant.length === 0) {
    return {
      fullSuite: false,
      reason: 'no-relevant-changes',
      changedPaths,
      changedWorkspaces: [],
      affectedWorkspaces: [],
      jobs: [],
    };
  }

  const fullSuiteTriggers = relevant.filter((p) =>
    matchesAny(FULL_SUITE_PATTERNS, p),
  );
  if (fullSuiteTriggers.length > 0) {
    return {
      fullSuite: true,
      reason: `shared-or-root-change:${fullSuiteTriggers[0]}`,
      changedPaths,
      changedWorkspaces: allNames,
      affectedWorkspaces: allNames,
      jobs: allNames,
    };
  }

  const changedWorkspaces = new Set();
  const unattributed = [];

  for (const p of relevant) {
    const ws = mapPathToWorkspace(p, workspaces);
    if (ws) {
      changedWorkspaces.add(ws.name);
    } else {
      unattributed.push(p);
    }
  }

  if (unattributed.length > 0) {
    return {
      fullSuite: true,
      reason: `unattributed-change:${unattributed[0]}`,
      changedPaths,
      changedWorkspaces: allNames,
      affectedWorkspaces: allNames,
      jobs: allNames,
    };
  }

  const affected = computeDependents(changedWorkspaces, deps);
  const affectedWorkspaces = [...affected].sort();

  return {
    fullSuite: false,
    reason: 'workspace-changes',
    changedPaths,
    changedWorkspaces: [...changedWorkspaces].sort(),
    affectedWorkspaces,
    jobs: affectedWorkspaces,
  };
}

function writeGithubOutput(plan) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) {
    process.stderr.write(
      'Warning: --github-output set but GITHUB_OUTPUT is not defined\n',
    );
    return;
  }
  const lines = [
    `full_suite=${plan.fullSuite}`,
    `reason=${plan.reason}`,
    `jobs=${plan.jobs.join(',')}`,
    `changed_workspaces=${plan.changedWorkspaces.join(',')}`,
    `affected_workspaces=${plan.affectedWorkspaces.join(',')}`,
  ];
  fs.appendFileSync(outFile, `${lines.join('\n')}\n`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  let plan;
  try {
    plan = computePlan(opts);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  const serialized = JSON.stringify(plan, null, 2);

  if (opts.dryRun) {
    process.stdout.write(`[dry-run] Plan:\n${serialized}\n`);
  } else if (opts.json) {
    process.stdout.write(`${serialized}\n`);
  } else {
    process.stdout.write(
      `full_suite=${plan.fullSuite} reason=${plan.reason} jobs=${plan.jobs.join(',') || '(none)'}\n`,
    );
  }

  if (opts.output && !opts.dryRun) {
    fs.writeFileSync(opts.output, `${serialized}\n`);
  }

  if (opts.githubOutput && !opts.dryRun) {
    writeGithubOutput(plan);
  }
}

main();