#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WORKFLOW_DIR = path.resolve(__dirname, '..', '..', '.github', 'workflows');

const DEPLOY_RELEASE_PATTERNS = [
  /^deploy-/i,
  /^release-/i,
  /publish/i,
];

function isDeployOrReleaseWorkflow(fileName) {
  return DEPLOY_RELEASE_PATTERNS.some((pattern) => pattern.test(fileName));
}

/**
 * Minimal YAML scanner that extracts the top-level `concurrency` block from a
 * workflow file. We intentionally avoid a full YAML dependency: we only need
 * the raw text of the top-level `concurrency:` key and its indented children.
 *
 * Returns the raw block text (including the `concurrency:` line) or null when
 * no top-level concurrency key is present.
 */
function extractTopLevelConcurrencyBlock(content) {
  const lines = content.split(/\r?\n/);
  let startIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Top-level keys start at column 0. Ignore comments and blank lines.
    if (/^concurrency\s*:/.test(line)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  const blockLines = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      blockLines.push(line);
      continue;
    }
    // Stop when we hit another top-level key (non-indented, non-comment).
    if (/^[^\s#]/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  return blockLines.join('\n');
}

function checkWorkflowContent(fileName, content) {
  const errors = [];

  const block = extractTopLevelConcurrencyBlock(content);
  if (block === null) {
    errors.push(`${fileName}: missing top-level "concurrency" declaration`);
    return errors;
  }

  if (!block.includes('github.workflow')) {
    errors.push(
      `${fileName}: concurrency group must include "github.workflow" to scope by workflow`,
    );
  }

  if (!block.includes('github.ref')) {
    errors.push(
      `${fileName}: concurrency group must include "github.ref" to scope by ref`,
    );
  }

  if (isDeployOrReleaseWorkflow(fileName)) {
    const cancelMatch = block.match(/cancel-in-progress\s*:\s*([^\s#]+)/);
    if (!cancelMatch) {
      errors.push(
        `${fileName}: deploy/release workflow must set "cancel-in-progress: false"`,
      );
    } else {
      const value = cancelMatch[1].trim().toLowerCase();
      if (value !== 'false') {
        errors.push(
          `${fileName}: deploy/release workflow must set "cancel-in-progress: false" (found "${cancelMatch[1].trim()}")`,
        );
      }
    }
  }

  return errors;
}

function checkWorkflowFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return checkWorkflowContent(path.basename(filePath), content);
}

function listWorkflowFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => path.join(dir, name));
}

function checkWorkflowDirectory(dir) {
  const files = listWorkflowFiles(dir);
  const errors = [];
  for (const file of files) {
    errors.push(...checkWorkflowFile(file));
  }
  return errors;
}

function main(argv) {
  const targetDir = argv[2] ? path.resolve(argv[2]) : DEFAULT_WORKFLOW_DIR;

  if (!fs.existsSync(targetDir)) {
    console.error(`Workflow directory not found: ${targetDir}`);
    process.exit(2);
  }

  let errors;
  try {
    errors = checkWorkflowDirectory(targetDir);
  } catch (err) {
    console.error(`Failed to check workflows: ${err.message}`);
    process.exit(2);
  }

  if (errors.length > 0) {
    console.error('Workflow concurrency check failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Workflow concurrency check passed.');
  process.exit(0);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  extractTopLevelConcurrencyBlock,
  checkWorkflowContent,
  checkWorkflowFile,
  checkWorkflowDirectory,
  isDeployOrReleaseWorkflow,
};
```

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkWorkflowContent,
  checkWorkflowDirectory,
  isDeployOrReleaseWorkflow,
} = require('./check-workflow-concurrency');

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

const COMPLIANT_PR_WORKFLOW = `name: PR Validation
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
`;

const COMPLIANT_DEPLOY_WORKFLOW = `name: Deploy Testnet
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: false
`;

const COMPLIANT_PUBLISH_WORKFLOW = `name: Publish Package
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: false
`;

run('compliant PR workflow passes', () => {
  const errors = checkWorkflowContent('pr-validation.yml', COMPLIANT_PR_WORKFLOW);
  assert.deepStrictEqual(errors, []);
});

run('compliant deploy workflow passes', () => {
  const errors = checkWorkflowContent('deploy-testnet.yml', COMPLIANT_DEPLOY_WORKFLOW);
  assert.deepStrictEqual(errors, []);
});

run('compliant publish workflow passes', () => {
  const errors = checkWorkflowContent('publish.yml', COMPLIANT_PUBLISH_WORKFLOW);
  assert.deepStrictEqual(errors, []);
});

run('missing concurrency is reported', () => {
  const content = `name: PR Validation
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const errors = checkWorkflowContent('pr-validation.yml', content);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /missing top-level "concurrency"/);
});

run('concurrency missing github.workflow is reported', () => {
  const content = `name: PR Validation
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
concurrency:
  group: \${{ github.ref }}
  cancel-in-progress: true
`;
  const errors = checkWorkflowContent('pr-validation.yml', content);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /github\.workflow/);
});

run('concurrency missing github.ref is reported', () => {
  const content = `name: PR Validation
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
concurrency:
  group: \${{ github.workflow }}
  cancel-in-progress: true
`;
  const errors = checkWorkflowContent('pr-validation.yml', content);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /github\.ref/);
});

run('deploy workflow with cancel-in-progress true is unsafe', () => {
  const content = `name: Deploy Testnet
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
`;
  const errors = checkWorkflowContent('deploy-testnet.yml', content);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /cancel-in-progress: false/);
});

run('deploy workflow missing cancel-in-progress is unsafe', () => {
  const content = `name: Deploy Testnet
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
`;
  const errors = checkWorkflowContent('deploy-testnet.yml', content);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /cancel-in-progress: false/);
});

run('publish workflow with cancel-in-progress true is unsafe', () => {
  const content = `name: Publish Package
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
`;
  const errors = checkWorkflowContent('publish.yml', content);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /cancel-in-progress: false/);
});

run('isDeployOrReleaseWorkflow classifies names', () => {
  assert.strictEqual(isDeployOrReleaseWorkflow('deploy-testnet.yml'), true);
  assert.strictEqual(isDeployOrReleaseWorkflow('release.yml'), true);
  assert.strictEqual(isDeployOrReleaseWorkflow('publish-package.yml'), true);
  assert.strictEqual(isDeployOrReleaseWorkflow('pr-validation.yml'), false);
  assert.strictEqual(isDeployOrReleaseWorkflow('ci.yml'), false);
});

run('directory check aggregates errors across files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-concurrency-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'pr-validation.yml'), COMPLIANT_PR_WORKFLOW);
    fs.writeFileSync(path.join(tmpDir, 'deploy-testnet.yml'), COMPLIANT_DEPLOY_WORKFLOW);
    fs.writeFileSync(
      path.join(tmpDir, 'broken.yml'),
      `name: Broken
on: push
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
    );

    const errors = checkWorkflowDirectory(tmpDir);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /broken\.yml/);
    assert.match(errors[0], /missing top-level "concurrency"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});