#!/usr/bin/env node
'use strict';

/**
 * check-lockfile-installs.js
 *
 * Verifies that dependency installation in CI is lockfile-reproducible:
 *   1. Each Node workspace (root, stellar-payment-platform, payment-dashboard)
 *      has a committed lockfile.
 *   2. CI workflows use `npm ci` (not `npm install`) for those workspaces.
 *   3. Any `--legacy-peer-deps` flag used in CI is documented in
 *      CONTRIBUTING.md.
 *
 * Exits non-zero on any violation. Designed to be runnable both from the
 * repository root and from tests (via the exported `checkLockfileInstalls`).
 */

const fs = require('fs');
const path = require('path');

const WORKSPACES = [
  { name: 'root', dir: '.', lockfile: 'package-lock.json' },
  { name: 'stellar-payment-platform', dir: 'stellar-payment-platform', lockfile: 'package-lock.json' },
  { name: 'payment-dashboard', dir: 'payment-dashboard', lockfile: 'package-lock.json' },
];

const WORKFLOW_DIR = path.join('.github', 'workflows');
const CONTRIBUTING_FILE = 'CONTRIBUTING.md';
const LEGACY_PEER_FLAG = '--legacy-peer-deps';

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function listWorkflowFiles(repoRoot) {
  const dir = path.join(repoRoot, WORKFLOW_DIR);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(dir, name));
}

/**
 * Determine whether a workflow file references a given workspace directory.
 * Root workspace is matched when the workflow references the repo root (no
 * subdirectory) — we treat any `npm ci`/`npm install` without a `cd` into a
 * known sub-workspace as targeting root.
 */
function workflowTargetsWorkspace(content, workspace) {
  if (workspace.name === 'root') {
    // Root is targeted when there is an install command that is not preceded
    // by a cd into one of the sub-workspaces. We approximate by checking for
    // install commands and, for sub-workspaces, that they are not the only
    // ones present.
    const installLines = content
      .split('\n')
      .filter((line) => /\bnpm\s+(ci|install)\b/.test(line));
    if (installLines.length === 0) return false;
    // If every install line is inside a sub-workspace block, root is not used.
    const subDirs = WORKSPACES.filter((w) => w.name !== 'root').map((w) => w.dir);
    return installLines.some((line) => {
      // A line is root-targeted if it does not reference a sub-workspace dir
      // and is not immediately preceded by a `cd <subdir>`.
      return !subDirs.some((dir) => line.includes(dir));
    });
  }
  return content.includes(workspace.dir);
}

/**
 * Extract install commands from a workflow file. Returns array of
 * { command, usesCi, usesInstall, usesLegacyPeerDeps, line }.
 */
function extractInstallCommands(content) {
  const results = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/\bnpm\s+(ci|install)\b([^\n]*)/);
    if (!match) continue;
    const subcommand = match[1];
    const rest = match[2] || '';
    results.push({
      line: i + 1,
      command: `npm ${subcommand}${rest}`.trim(),
      usesCi: subcommand === 'ci',
      usesInstall: subcommand === 'install',
      usesLegacyPeerDeps: rest.includes(LEGACY_PEER_FLAG),
    });
  }
  return results;
}

/**
 * Main check. Returns { ok, errors, warnings, details }.
 *
 * @param {string} repoRoot absolute path to repository root
 */
function checkLockfileInstalls(repoRoot) {
  const errors = [];
  const warnings = [];
  const details = { workspaces: {}, workflows: [], legacyPeerDeps: [] };

  // 1. Lockfiles present.
  for (const ws of WORKSPACES) {
    const lockPath = path.join(repoRoot, ws.dir, ws.lockfile);
    const exists = fs.existsSync(lockPath);
    details.workspaces[ws.name] = { lockfile: lockPath, present: exists };
    if (!exists) {
      errors.push(
        `Missing lockfile for workspace "${ws.name}": expected ${path.join(ws.dir, ws.lockfile)}`
      );
    }
  }

  // 2. Workflows use npm ci for each workspace, not npm install.
  const workflowFiles = listWorkflowFiles(repoRoot);
  if (workflowFiles.length === 0) {
    warnings.push(`No workflow files found under ${WORKFLOW_DIR}`);
  }

  const workspaceCiCoverage = {};
  for (const ws of WORKSPACES) workspaceCiCoverage[ws.name] = false;

  for (const wfPath of workflowFiles) {
    const content = readFileSafe(wfPath);
    if (content == null) continue;
    const commands = extractInstallCommands(content);
    const relPath = path.relative(repoRoot, wfPath);
    details.workflows.push({ file: relPath, commands });

    for (const cmd of commands) {
      if (cmd.usesLegacyPeerDeps) {
        details.legacyPeerDeps.push({ file: relPath, line: cmd.line, command: cmd.command });
      }
      if (cmd.usesInstall) {
        // Determine which workspace this install targets.
        const targets = WORKSPACES.filter((ws) => workflowTargetsWorkspace(content, ws));
        const targetNames = targets.map((t) => t.name).join(', ') || 'unknown';
        errors.push(
          `Workflow ${relPath}:${cmd.line} uses "npm install" (targets: ${targetNames}); use "npm ci" for lockfile-reproducible installs.`
        );
      }
      if (cmd.usesCi) {
        for (const ws of WORKSPACES) {
          if (workflowTargetsWorkspace(content, ws)) {
            workspaceCiCoverage[ws.name] = true;
          }
        }
      }
    }
  }

  for (const ws of WORKSPACES) {
    if (!workspaceCiCoverage[ws.name]) {
      warnings.push(
        `No "npm ci" install detected in CI workflows for workspace "${ws.name}".`
      );
    }
  }

  // 3. --legacy-peer-deps must be documented in CONTRIBUTING.md.
  if (details.legacyPeerDeps.length > 0) {
    const contributingPath = path.join(repoRoot, CONTRIBUTING_FILE);
    const contributing = readFileSafe(contributingPath);
    if (contributing == null) {
      errors.push(
        `CI uses ${LEGACY_PEER_FLAG} but ${CONTRIBUTING_FILE} does not exist to document it.`
      );
    } else if (!contributing.includes(LEGACY_PEER_FLAG)) {
      errors.push(
        `CI uses ${LEGACY_PEER_FLAG} but it is not documented in ${CONTRIBUTING_FILE}.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details,
  };
}

function main() {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const result = checkLockfileInstalls(repoRoot);

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
    console.error(`\nLockfile install check failed with ${result.errors.length} error(s).`);
    process.exit(1);
  }
  console.log('Lockfile install check passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  checkLockfileInstalls,
  extractInstallCommands,
  workflowTargetsWorkspace,
  WORKSPACES,
  LEGACY_PEER_FLAG,
};