#!/usr/bin/env node
'use strict';

/**
 * check-pinned-images.js
 *
 * Verifies that every container base image referenced by the repository is
 * pinned to an immutable digest (`@sha256:<64 hex>`).
 *
 * Scanned inputs (relative to the target directory):
 *   - Dockerfile
 *   - Dockerfile-backend
 *   - docker-compose.yml (and docker-compose.yaml)
 *
 * Rules:
 *   - `FROM <image>` lines in Dockerfiles must reference a digest.
 *   - `image: <image>` entries in compose files must reference a digest.
 *   - `FROM` lines using a prior build stage (`FROM builder`) are skipped.
 *   - `scratch` is allowed (it is not a registry image).
 *   - `ARG`-substituted references (containing `$`) are reported as
 *     violations because they cannot be verified statically.
 *
 * Usage:
 *   node scripts/ci/check-pinned-images.js [--dir <path>]
 *
 * Exit codes:
 *   0 - all base images are pinned by digest
 *   1 - one or more violations found
 *   2 - usage / IO error
 */

const fs = require('fs');
const path = require('path');

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/i;
const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*$/i;
const IMAGE_RE = /^\s*image:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/i;

const DEFAULT_FILES = [
  'Dockerfile',
  'Dockerfile-backend',
  'docker-compose.yml',
  'docker-compose.yaml',
];

/**
 * Determine whether an image reference is pinned by digest.
 * @param {string} ref
 * @returns {boolean}
 */
function isPinnedByDigest(ref) {
  return DIGEST_RE.test(ref);
}

/**
 * Check a single image reference.
 * @param {string} ref
 * @param {Set<string>} [buildStages] names of previously declared build stages
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkImageRef(ref, buildStages) {
  if (!ref) {
    return { ok: false, reason: 'empty image reference' };
  }
  if (ref === 'scratch') {
    return { ok: true };
  }
  if (buildStages && buildStages.has(ref.toLowerCase())) {
    return { ok: true };
  }
  if (ref.includes('$')) {
    return {
      ok: false,
      reason: `image "${ref}" uses variable substitution and cannot be verified`,
    };
  }
  if (!isPinnedByDigest(ref)) {
    return {
      ok: false,
      reason: `image "${ref}" is not pinned to an @sha256:<64 hex> digest`,
    };
  }
  return { ok: true };
}

/**
 * Scan a Dockerfile's contents for unpinned base images.
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<{ file: string, line: number, ref: string, reason: string }>}
 */
function scanDockerfile(content, filePath) {
  const violations = [];
  const buildStages = new Set();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = FROM_RE.exec(line);
    if (!match) continue;

    const ref = match[1];
    const result = checkImageRef(ref, buildStages);
    if (!result.ok) {
      violations.push({ file: filePath, line: i + 1, ref, reason: result.reason });
    }

    const asMatch = /^\s*FROM\s+(?:--platform=\S+\s+)?\S+\s+AS\s+(\S+)\s*$/i.exec(line);
    if (asMatch) {
      buildStages.add(asMatch[1].toLowerCase());
    }
  }

  return violations;
}

/**
 * Scan a compose file's contents for unpinned images.
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<{ file: string, line: number, ref: string, reason: string }>}
 */
function scanComposeFile(content, filePath) {
  const violations = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = IMAGE_RE.exec(lines[i]);
    if (!match) continue;

    const ref = match[1];
    const result = checkImageRef(ref);
    if (!result.ok) {
      violations.push({ file: filePath, line: i + 1, ref, reason: result.reason });
    }
  }

  return violations;
}

/**
 * Scan a single file, dispatching on its name.
 * @param {string} content
 * @param {string} filePath
 * @returns {Array<{ file: string, line: number, ref: string, reason: string }>}
 */
function scanFileContent(content, filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile-')) {
    return scanDockerfile(content, filePath);
  }
  if (base === 'docker-compose.yml' || base === 'docker-compose.yaml') {
    return scanComposeFile(content, filePath);
  }
  return [];
}

/**
 * Check all known container definition files in a directory.
 * @param {string} dir
 * @returns {Array<{ file: string, line: number, ref: string, reason: string }>}
 */
function checkPinnedImages(dir) {
  const violations = [];
  for (const name of DEFAULT_FILES) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    violations.push(...scanFileContent(content, filePath));
  }
  return violations;
}

function parseArgs(argv) {
  const args = { dir: '.' };
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
      'Usage: node scripts/ci/check-pinned-images.js [--dir <path>]\n'
    );
    return 0;
  }

  let violations;
  try {
    violations = checkPinnedImages(args.dir);
  } catch (err) {
    process.stderr.write(`check-pinned-images: ${err.message}\n`);
    return 2;
  }

  if (violations.length === 0) {
    process.stdout.write('check-pinned-images: all base images are pinned.\n');
    return 0;
  }

  process.stderr.write(
    `check-pinned-images: found ${violations.length} unpinned base image(s):\n`
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}: ${v.reason}\n`);
  }
  process.stderr.write(
    '\nPin base images to a full digest, e.g.:\n' +
      '  FROM node:20-bookworm-slim@sha256:<64 hex>\n'
  );
  return 1;
}

module.exports = {
  isPinnedByDigest,
  checkImageRef,
  scanDockerfile,
  scanComposeFile,
  scanFileContent,
  checkPinnedImages,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

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