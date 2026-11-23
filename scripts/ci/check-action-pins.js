#!/usr/bin/env node
'use strict';

/**
 * check-action-pins.js
 *
 * Verifies that every external GitHub Actions `uses:` reference in
 * `.github/workflows/*.yml` (and `.yaml`) is pinned to an immutable 40-character
 * commit SHA and carries a readable `# vX.Y.Z` version comment.
 *
 * Rules:
 *   - Local actions (`./...`) are allowed and skipped.
 *   - Docker references (`docker://...`) are allowed and skipped.
 *   - External `owner/repo[/path]@ref` references must use a 40-char hex SHA.
 *   - The line must include a `# vX.Y.Z` (or `# vX.Y.Z-...`) comment.
 *
 * Usage:
 *   node scripts/ci/check-action-pins.js [--dir <path>]
 *
 * Exit codes:
 *   0 - all references are pinned correctly
 *   1 - one or more violations found
 *   2 - usage / IO error
 */

const fs = require('fs');
const path = require('path');

const SHA_RE = /^[0-9a-f]{40}$/i;
const VERSION_COMMENT_RE = /#\s*v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;
const USES_RE = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/;

/**
 * Parse a single `uses:` value into its reference and optional comment.
 * @param {string} rawValue
 * @returns {{ ref: string, comment: string }}
 */
function parseUsesValue(rawValue) {
  const hashIndex = rawValue.indexOf('#');
  if (hashIndex === -1) {
    return { ref: rawValue.trim(), comment: '' };
  }
  return {
    ref: rawValue.slice(0, hashIndex).trim(),
    comment: rawValue.slice(hashIndex).trim(),
  };
}

/**
 * Determine whether a `uses:` reference is external (i.e. must be pinned).
 * @param {string} ref
 * @returns {boolean}
 */
function isExternalRef(ref) {
  if (!ref) return false;
  if (ref.startsWith('./') || ref.startsWith('../')) return false;
  if (ref.startsWith('docker://')) return false;
  return true;
}

/**
 * Check a single `uses:` reference.
 * @param {string} ref
 * @param {string} comment
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkReference(ref, comment) {
  if (!isExternalRef(ref)) {
    return { ok: true };
  }

  const atIndex = ref.lastIndexOf('@');
  if (atIndex === -1) {
    return { ok: false, reason: `missing '@<sha>' in reference "${ref}"` };
  }

  const sha = ref.slice(atIndex + 1);
  if (!SHA_RE.test(sha)) {
    return {
      ok: false,
      reason: `reference "${ref}" is not pinned to a 40-character commit SHA`,
    };
  }

  if (!VERSION_COMMENT_RE.test(comment)) {
    return {
      ok: false,
      reason: `reference "${ref}" is missing a '# vX.Y.Z' version comment`,
    };
  }

  return { ok: true };
}

/**
 * Scan a workflow file's contents for violations.
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<{ file: string, line: number, ref: string, reason: string }>}
 */
function scanContent(content, filePath) {
  const violations = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = USES_RE.exec(line);
    if (!match) continue;

    const { ref, comment } = parseUsesValue(match[1]);
    const result = checkReference(ref, comment);
    if (!result.ok) {
      violations.push({
        file: filePath,
        line: i + 1,
        ref,
        reason: result.reason,
      });
    }
  }

  return violations;
}

/**
 * List workflow files in a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function listWorkflowFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => path.join(dir, name));
}

/**
 * Run the check across a workflows directory.
 * @param {string} workflowsDir
 * @returns {Array<{ file: string, line: number, ref: string, reason: string }>}
 */
function checkWorkflowsDir(workflowsDir) {
  const violations = [];
  for (const file of listWorkflowFiles(workflowsDir)) {
    const content = fs.readFileSync(file, 'utf8');
    violations.push(...scanContent(content, file));
  }
  return violations;
}

function parseArgs(argv) {
  const args = { dir: path.join('.github', 'workflows') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      args.dir = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/ci/check-action-pins.js [--dir <workflows-dir>]\n'
    );
    return 0;
  }

  let violations;
  try {
    violations = checkWorkflowsDir(args.dir);
  } catch (err) {
    process.stderr.write(`check-action-pins: ${err.message}\n`);
    return 2;
  }

  if (violations.length === 0) {
    process.stdout.write('check-action-pins: all action references are pinned.\n');
    return 0;
  }

  process.stderr.write(
    `check-action-pins: found ${violations.length} unpinned action reference(s):\n`
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}: ${v.reason}\n`);
  }
  process.stderr.write(
    '\nPin external actions to a full 40-character commit SHA and add a\n' +
      "'# vX.Y.Z' comment, e.g.:\n" +
      '  uses: actions/checkout@<40-char-sha> # v4.1.7\n'
  );
  return 1;
}

module.exports = {
  parseUsesValue,
  isExternalRef,
  checkReference,
  scanContent,
  listWorkflowFiles,
  checkWorkflowsDir,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}