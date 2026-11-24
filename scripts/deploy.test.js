'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  fetchOnChainWasmHash,
  loadReleaseManifest,
  parseArgs,
  validateOptions,
  upgradeReleaseManifest,
  buildArtifact,
  promoteArtifact,
  rollbackArtifact,
  preflightReleaseManifest,
  runSmokeChecks,
  generateProvenance,
  verifyProvenance,
  verifyImageSignature,
  runCanaryRollout,
} = require('./deploy');

const makeReleaseFixture = (overrides = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorobankit-release-'));
  const artifacts = {};
  const contracts = [
    {
      name: 'router',
      contract_id: `C${'A'.repeat(55)}`,
      wasm_path: 'router.wasm',
      interface_version: 1,
      dependencies: ['token'],
    },
    {
      name: 'token',
      contract_id: `C${'B'.repeat(55)}`,
      wasm_path: 'token.wasm',
      interface_version: 1,
      dependencies: [],
    },
  ].map((entry) => {
    const contents = Buffer.from(`wasm:${entry.name}`);
    fs.writeFileSync(path.join(directory, entry.wasm_path), contents);
    const wasm_sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    artifacts[entry.name] = { ...entry, wasm_sha256 };
    return { ...entry, wasm_sha256 };
  });
  const manifest = {
    schema_version: 1,
    network: 'testnet',
    contracts,
    ...overrides,
  };
  const manifestPath = path.join(directory, 'release.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { directory, manifest, manifestPath, artifacts };
};

test('CLI parses and validates queued action execution arguments', () => {
  const options = parseArgs([
    'execute-action',
    '--contract-id',
    `C${'A'.repeat(55)}`,
    '--nonce',
    '42',
    '--network',
    'testnet',
  ]);
  assert.equal(options.timelockNonce, 42);
  assert.equal(validateOptions(options), true);

  const manifestOptions = parseArgs([
    'upgrade-manifest',
    '--manifest',
    'release.json',
    '--execute',
  ]);
  assert.equal(manifestOptions.execute, true);
});

test('release manifest validates local hashes and sorts dependencies first', (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const { orderedContracts } = loadReleaseManifest(fixture.manifestPath, 'testnet');
  assert.deepEqual(orderedContracts.map(({ name }) => name), ['token', 'router']);
});

test('uploaded WASM verification hashes the blob returned by Soroban RPC', async (t) => {
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
  });
  const wasm = Buffer.from('uploaded contract WASM');
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ result: { wasm: wasm.toString('base64') } }),
  });

  const hash = await fetchOnChainWasmHash('ignored-hash', { rpcUrl: 'http://rpc.invalid' });
  assert.equal(hash, crypto.createHash('sha256').update(wasm).digest('hex'));
});

test('release manifest rejects mismatched networks, hashes, missing dependencies, and cycles', (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  assert.throws(
    () => loadReleaseManifest(fixture.manifestPath, 'mainnet'),
    /does not match selected network/
  );

  fixture.manifest.contracts[0].wasm_sha256 = 'f'.repeat(64);
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
  assert.throws(() => loadReleaseManifest(fixture.manifestPath, 'testnet'), /WASM hash mismatch/);

  fixture.manifest.contracts[0].wasm_sha256 = fixture.artifacts.router.wasm_sha256;
  fixture.manifest.contracts[0].dependencies = ['missing'];
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
  assert.throws(() => loadReleaseManifest(fixture.manifestPath, 'testnet'), /unknown contract/);

  fixture.manifest.contracts[0].dependencies = ['token'];
  fixture.manifest.contracts[1].dependencies = ['router'];
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
  assert.throws(() => loadReleaseManifest(fixture.manifestPath, 'testnet'), /dependency cycle/);
});

test('release preflight fails before any network operation on an invalid artifact', async (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fixture.manifest.contracts[0].wasm_sha256 = 'f'.repeat(64);
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));

  let commandCount = 0;
  await assert.rejects(
    upgradeReleaseManifest({
      manifestPath: fixture.manifestPath,
      network: 'testnet',
      runCommand: () => {
        commandCount += 1;
        return '';
      },
    }),
    /WASM hash mismatch/
  );
  assert.equal(commandCount, 0);
});

test('coordinated upgrade queues dependencies first and persists each nonce', async (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const commands = [];
  let nextNonce = 1;
  await upgradeReleaseManifest({
    manifestPath: fixture.manifestPath,
    network: 'testnet',
    source: 'deployer',
    runCommand: (_command, args) => {
      commands.push(args);
      if (args[1] === 'install') {
        const wasmPath = args[3];
        const contract = Object.values(fixture.artifacts).find(
          (entry) => path.join(fixture.directory, entry.wasm_path) === wasmPath
        );
        return contract.wasm_sha256;
      }
      if (args.includes('queue_upgrade')) {
        return String(nextNonce++);
      }
      return '';
    },
    getUploadedHash: async (hash) => hash,
  });

  const invokedIds = commands
    .filter((args) => args[0] === 'contract' && args[1] === 'invoke')
    .map((args) => args[3]);
  assert.deepEqual(invokedIds, [
    fixture.artifacts.token.contract_id,
    fixture.artifacts.router.contract_id,
  ]);
  const persistedManifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.deepEqual(
    persistedManifest.contracts.map(({ name, queued_action_nonce }) => [name, queued_action_nonce]),
    [['router', 2], ['token', 1]]
  );
});

test('coordinated execution verifies deployed hashes and interface versions', async (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fixture.manifest.contracts.forEach((contract, index) => {
    contract.queued_action_nonce = index + 1;
  });
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));

  const commands = [];
  const verifiedContracts = [];
  const hashReads = new Map();
  await upgradeReleaseManifest({
    manifestPath: fixture.manifestPath,
    network: 'testnet',
    execute: true,
    runCommand: (_command, args) => {
      commands.push(args);
      return '';
    },
    getContractHash: async (contractId) => {
      const contract = Object.values(fixture.artifacts).find(
        (entry) => entry.contract_id === contractId
      );
      verifiedContracts.push(contract.name);
      const reads = hashReads.get(contract.name) || 0;
      hashReads.set(contract.name, reads + 1);
      return reads === 0 ? '0'.repeat(64) : contract.wasm_sha256;
    },
    getInterfaceVersion: async () => 1,
  });

  assert.deepEqual(verifiedContracts, ['token', 'token', 'router', 'router']);
  assert.deepEqual(
    commands.filter((args) => args.includes('execute_action')).map((args) => args[3]),
    [fixture.artifacts.token.contract_id, fixture.artifacts.router.contract_id]
  );
  const persistedManifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.ok(persistedManifest.contracts.every((contract) => !('queued_action_nonce' in contract)));
});

test('coordinated execution recovers when the action ran before manifest persistence', async (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fixture.manifest.contracts.forEach((contract, index) => {
    contract.queued_action_nonce = index + 1;
  });
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));

  const executedIds = [];
  const hashReads = new Map();
  await upgradeReleaseManifest({
    manifestPath: fixture.manifestPath,
    network: 'testnet',
    execute: true,
    runCommand: (_command, args) => {
      if (args.includes('execute_action')) {
        executedIds.push(args[3]);
      }
      return '';
    },
    getContractHash: async (contractId) => {
      const contract = Object.values(fixture.artifacts).find(
        (entry) => entry.contract_id === contractId
      );
      const reads = hashReads.get(contract.name) || 0;
      hashReads.set(contract.name, reads + 1);
      return contract.name === 'token' || reads > 0
        ? contract.wasm_sha256
        : '0'.repeat(64);
    },
    getInterfaceVersion: async () => 1,
  });

  assert.deepEqual(executedIds, [fixture.artifacts.router.contract_id]);
  const persistedManifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.ok(persistedManifest.contracts.every((contract) => !('queued_action_nonce' in contract)));
});

test('coordinated execution stops when resulting on-chain WASM hash differs', async (t) => {
  const fixture = makeReleaseFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fixture.manifest.contracts.forEach((contract, index) => {
    contract.queued_action_nonce = index + 1;
  });
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
  let invokedCount = 0;

  await assert.rejects(
    upgradeReleaseManifest({
      manifestPath: fixture.manifestPath,
      network: 'testnet',
      execute: true,
      runCommand: (_command, args) => {
        if (args.includes('execute_action')) {
          invokedCount += 1;
        }
        return '';
      },
      getContractHash: async () => '0'.repeat(64),
      getInterfaceVersion: async () => 1,
    }),
    /Deployed contract WASM hash verification failed/
  );
  assert.equal(invokedCount, 1);
});

const makePipelineFixture = (overrides = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorobankit-pipeline-'));
  const wasm = Buffer.from('immutable backend artifact');
  const wasmPath = path.join(directory, 'backend.wasm');
  fs.writeFileSync(wasmPath, wasm);
  const digest = crypto.createHash('sha256').update(wasm).digest('hex');
  const config = {
    staging: { rpc_url: 'http://staging.invalid', network: 'testnet' },
    production: { rpc_url: 'http://prod.invalid', network: 'mainnet' },
  };
  const configPath = path.join(directory, 'env.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { directory, wasmPath, digest, configPath, config, ...overrides };
};

test('build records an immutable digest and refuses to rebuild a different artifact', (t) => {
  const fixture = makePipelineFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const record = buildArtifact({ wasmPath: fixture.wasmPath, buildId: 'build-1' });
  assert.equal(record.digest, fixture.digest);
  assert.equal(record.build_id, 'build-1');

  const rebuilt = buildArtifact({ wasmPath: fixture.wasmPath, buildId: 'build-1' });
  assert.equal(rebuilt.digest, fixture.digest);

  fs.writeFileSync(fixture.wasmPath, Buffer.from('mutated artifact'));
  assert.throws(
    () => buildArtifact({ wasmPath: fixture.wasmPath, buildId: 'build-1' }),
    /immutable/
  );
});

test('promotion moves the same digest through staging then production with external config', (t) => {
  const fixture = makePipelineFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const record = buildArtifact({ wasmPath: fixture.wasmPath, buildId: 'build-1' });

  const staging = promoteArtifact({
    record,
    environment: 'staging',
    configPath: fixture.configPath,
    approver: 'alice',
  });
  assert.equal(staging.digest, fixture.digest);
  assert.equal(staging.environment, 'staging');
  assert.equal(staging.config.rpc_url, fixture.config.staging.rpc_url);

  assert.throws(
    () =>
      promoteArtifact({
        record,
        environment: 'production',
        configPath: fixture.configPath,
      }),
    /approver/
  );

  const production = promoteArtifact({
    record,
    environment: 'production',
    configPath: fixture.configPath,
    approver: 'bob',
    deploymentId: 'deploy-42',
  });
  assert.equal(production.digest, fixture.digest);
  assert.equal(production.approver, 'bob');
  assert.equal(production.deployment_id, 'deploy-42');
  assert.equal(production.config.rpc_url, fixture.config.production.rpc_url);
});

test('promotion rejects an unknown environment and a digest that does not match the artifact', (t) => {
  const fixture = makePipelineFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const record = buildArtifact({ wasmPath: fixture.wasmPath, buildId: 'build-1' });

  assert.throws(
    () =>
      promoteArtifact({
        record,
        environment: 'qa',
        configPath: fixture.configPath,
        approver: 'alice',
      }),
    /environment/
  );

  assert.throws(
    () =>
      promoteArtifact({
        record: { ...record, digest: 'f'.repeat(64) },
        environment: 'staging',
        configPath: fixture.configPath,
        approver: 'alice',
      }),
    /digest/
  );
});

test('rollback restores a previously verified digest and rejects unverified digests', (t) => {
  const fixture = makePipelineFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const record = buildArtifact({ wasmPath: fixture.wasmPath, buildId: 'build-1' });
  const history = [
    promoteArtifact({
      record,
      environment: 'production',
      configPath: fixture.configPath,
      approver: 'bob',
      deploymentId: 'deploy-1',
    }),
  ];

  const rolledBack = rollbackArtifact({
    history,
    digest: fixture.digest,
    environment: 'production',
    configPath: fixture.configPath,
    approver: 'carol',
    deploymentId: 'deploy-2',
  });
  assert.equal(rolledBack.digest, fixture.digest);
  assert.equal(rolledBack.deployment_id, 'deploy-2');
  assert.equal(rolledBack.approver, 'carol');

  assert.throws(
    () =>
      rollbackArtifact({
        history,
        digest: 'a'.repeat(64),
        environment: 'production',
        configPath: fixture.configPath,
        approver: 'carol',
      }),
    /verified/
  );
});

test('release manifest preflight rejects mismatched dashboard, client, and contract versions', () => {
  const manifest = {
    schema_version: 1,
    package_versions: { api: '1.2.0', dashboard: '1.2.0', client: '1.2.0' },
    wasm_sha256: 'a'.repeat(64),
    interface_schema: 3,
    supported_networks: ['testnet', 'mainnet'],
    migration_level: 7,
    contracts: [{ name: 'router', interface_version: 3 }],
  };

  assert.equal(preflightReleaseManifest({ manifest, network: 'testnet' }), true);

  assert.throws(
    () =>
      preflightReleaseManifest({
        manifest: { ...manifest, package_versions: { ...manifest.package_versions, dashboard: '1.1.0' } },
        network: 'testnet',
      }),
    /dashboard/
  );

  assert.throws(
    () =>
      preflightReleaseManifest({
        manifest: { ...manifest, package_versions: { ...manifest.package_versions, client: '2.0.0' } },
        network: 'testnet',
      }),
    /client/
  );

  assert.throws(
    () =>
      preflightReleaseManifest({
        manifest: { ...manifest, contracts: [{ name: 'router', interface_version: 2 }] },
        network: 'testnet',
      }),
    /interface/
  );

  assert.throws(
    () => preflightReleaseManifest({ manifest, network: 'futurenet' }),
    /network/
  );
});

test('smoke checks verify hash, network, admin, and read interface and publish deployment id', async () => {
  const expected = {
    wasm_sha256: 'a'.repeat(64),
    network: 'testnet',
    admin: `G${'A'.repeat(55)}`,
    interface_version: 3,
  };
  const calls = [];
  const result = await runSmokeChecks({
    deploymentId: 'deploy-9',
    expected,
    readContract: async (method) => {
      calls.push(method);
      if (method === 'admin') return expected.admin;
      if (method === 'version') return expected.interface_version;
      return null;
    },
    getContractHash: async () => expected.wasm_sha256,
    getNetwork: async () => expected.network,
  });
  assert.equal(result.deployment_id, 'deploy-9');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['admin', 'version']);
});

test('smoke checks fail on hash mismatch, wrong network, and admin mismatch', async () => {
  const expected = {
    wasm_sha256: 'a'.repeat(64),
    network: 'testnet',
    admin: `G${'A'.repeat(55)}`,
    interface_version: 3,
  };
  const base = {
    deploymentId: 'deploy-9',
    expected,
    readContract: async (method) =>
      method === 'admin' ? expected.admin : expected.interface_version,
    getContractHash: async () => expected.wasm_sha256,
    getNetwork: async () => expected.network,
  };

  await assert.rejects(
    runSmokeChecks({ ...base, getContractHash: async () => 'b'.repeat(64) }),
    /WASM hash/
  );
  await assert.rejects(
    runSmokeChecks({ ...base, getNetwork: async () => 'mainnet' }),
    /network/
  );
  await assert.rejects(
    runSmokeChecks({ ...base, readContract: async (method) => (method === 'admin' ? 'other' : 3) }),
    /admin/
  );
});

test('smoke checks prevent duplicate test transactions under concurrent invocation', async () => {
  const expected = {
    wasm_sha256: 'a'.repeat(64),
    network: 'testnet',
    admin: `G${'A'.repeat(55)}`,
    interface_version: 3,
  };
  let submissions = 0;
  const submitTestTransaction = async () => {
    submissions += 1;
    return `tx-${submissions}`;
  };
  const options = {
    deploymentId: 'deploy-9',
    expected,
    readContract: async (method) => (method === 'admin' ? expected.admin : 3),
    getContractHash: async () => expected.wasm_sha256,
    getNetwork: async () => expected.network,
    submitTestTransaction,
  };

  const [first, second] = await Promise.all([
    runSmokeChecks(options),
    runSmokeChecks(options),
  ]);
  assert.equal(submissions, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

const makeProvenanceFixture = (overrides = {}) => {
  const digest = crypto.createHash('sha256').update('provenance artifact').digest('hex');
  return {
    digest,
    sourceCommit: 'a'.repeat(40),
    workflowIdentity:
      'https://github.com/example/sorobankit/.github/workflows/release.yml@refs/heads/main',
    toolchain: { node: '20.11.1', rust: '1.77.0', soroban: '21.0.0' },
    artifactName: 'backend.wasm',
    ...overrides,
  };
};

test('provenance attestation binds source commit, workflow identity, toolchain, and digest', () => {
  const fixture = makeProvenanceFixture();
  const attestation = generateProvenance(fixture);

  assert.equal(attestation.digest, fixture.digest);
  assert.equal(attestation.source_commit, fixture.sourceCommit);
  assert.equal(attestation.workflow_identity, fixture.workflowIdentity);
  assert.deepEqual(attestation.toolchain, fixture.toolchain);
  assert.equal(attestation.artifact_name, fixture.artifactName);
  assert.equal(attestation.schema_version, 1);
  assert.match(attestation.signature, /^[0-9a-f]{64}$/);

  const verified = verifyProvenance({
    attestation,
    expected: {
      digest: fixture.digest,
      sourceCommit: fixture.sourceCommit,
      workflowIdentity: fixture.workflowIdentity,
      toolchain: fixture.toolchain,
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.digest, fixture.digest);
});

test('provenance verification fails when the artifact digest does not match', () => {
  const fixture = makeProvenanceFixture();
  const attestation = generateProvenance(fixture);

  assert.throws(
    () =>
      verifyProvenance({
        attestation,
        expected: {
          digest: 'f'.repeat(64),
          sourceCommit: fixture.sourceCommit,
          workflowIdentity: fixture.workflowIdentity,
          toolchain: fixture.toolchain,
        },
      }),
    /digest/
  );
});

test('provenance verification fails when the source commit or workflow identity differs', () => {
  const fixture = makeProvenanceFixture();
  const attestation = generateProvenance(fixture);
  const expected = {
    digest: fixture.digest,
    sourceCommit: fixture.sourceCommit,
    workflowIdentity: fixture.workflowIdentity,
    toolchain: fixture.toolchain,
  };

  assert.throws(
    () => verifyProvenance({ attestation, expected: { ...expected, sourceCommit: 'b'.repeat(40) } }),
    /source commit/
  );
  assert.throws(
    () =>
      verifyProvenance({
        attestation,
        expected: { ...expected, workflowIdentity: 'https://github.com/evil/workflow.yml' },
      }),
    /workflow identity/
  );
});

test('provenance verification rejects malformed and missing attestations', () => {
  const fixture = makeProvenanceFixture();
  const expected = {
    digest: fixture.digest,
    sourceCommit: fixture.sourceCommit,
    workflowIdentity: fixture.workflowIdentity,
    toolchain: fixture.toolchain,
  };

  assert.throws(() => verifyProvenance({ attestation: null, expected }), /missing/);
  assert.throws(() => verifyProvenance({ expected }), /missing/);

  const attestation = generateProvenance(fixture);
  assert.throws(
    () => verifyProvenance({ attestation: { ...attestation, signature: 'not-a-signature' }, expected }),
    /malformed/
  );
  assert.throws(
    () => verifyProvenance({ attestation: { ...attestation, schema_version: 99 }, expected }),
    /malformed/
  );
  assert.throws(
    () =>
      verifyProvenance({
        attestation: { ...attestation, digest: 'f'.repeat(64) },
        expected,
      }),
    /malformed|signature/
  );
});

const makeSignatureFixture = (overrides = {}) => {
  const digest = `sha256:${crypto.createHash('sha256').update('image').digest('hex')}`;
  return {
    image: `ghcr.io/example/sorobankit-backend@${digest}`,
    digest,
    workloadIdentity:
      'https://github.com/example/sorobankit/.github/workflows/release.yml@refs/heads/main',
    ...overrides,
  };
};

test('image signature verification accepts a signed immutable digest', () => {
  const fixture = makeSignatureFixture();
  const signature = crypto
    .createHash('sha256')
    .update(`${fixture.digest}:${fixture.workloadIdentity}`)
    .digest('hex');

  const result = verifyImageSignature({
    image: fixture.image,
    workloadIdentity: fixture.workloadIdentity,
    signatures: [{ digest: fixture.digest, identity: fixture.workloadIdentity, signature }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.digest, fixture.digest);
});

test('image signature verification rejects unsigned images and digest mismatches', () => {
  const fixture = makeSignatureFixture();
  const signature = crypto
    .createHash('sha256')
    .update(`${fixture.digest}:${fixture.workloadIdentity}`)
    .digest('hex');

  assert.throws(
    () =>
      verifyImageSignature({
        image: fixture.image,
        workloadIdentity: fixture.workloadIdentity,
        signatures: [],
      }),
    /unsigned/
  );

  assert.throws(
    () =>
      verifyImageSignature({
        image: fixture.image,
        workloadIdentity: fixture.workloadIdentity,
        signatures: [
          { digest: `sha256:${'0'.repeat(64)}`, identity: fixture.workloadIdentity, signature },
        ],
      }),
    /digest/
  );

  assert.throws(
    () =>
      verifyImageSignature({
        image: fixture.image,
        workloadIdentity: fixture.workloadIdentity,
        signatures: [{ digest: fixture.digest, identity: 'other-identity', signature }],
      }),
    /identity/
  );
});

test('image signature verification supports audited break-glass recovery', () => {
  const fixture = makeSignatureFixture();
  const audit = [];

  assert.throws(
    () =>
      verifyImageSignature({
        image: fixture.image,
        workloadIdentity: fixture.workloadIdentity,
        signatures: [],
        breakGlass: { approver: 'alice' },
        audit: (entry) => audit.push(entry),
      }),
    /unsigned/
  );

  const result = verifyImageSignature({
    image: fixture.image,
    workloadIdentity: fixture.workloadIdentity,
    signatures: [],
    breakGlass: { approver: 'alice', reason: 'signing service outage' },
    audit: (entry) => audit.push(entry),
  });
  assert.equal(result.ok, true);
  assert.equal(result.break_glass, true);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].approver, 'alice');
  assert.equal(audit[0].reason, 'signing service outage');

  assert.throws(
    () =>
      verifyImageSignature({
        image: fixture.image,
        workloadIdentity: fixture.workloadIdentity,
        signatures: [],
        breakGlass: { reason: 'no approver' },
        audit: () => {},
      }),
    /approver/
  );
});

const makeCanaryFixture = (overrides = {}) => ({
  deploymentId: 'deploy-canary-1',
  baselineDigest: 'a'.repeat(64),
  canaryDigest: 'b'.repeat(64),
  policy: {
    trafficPercent: 10,
    evaluationWindowMs: 1000,
    maxErrorRate: 0.01,
    maxP99LatencyMs: 500,
  },
  ...overrides,
});

test('canary rollout promotes when metrics stay within policy', async () => {
  const fixture = makeCanaryFixture();
  const audit = [];
  const result = await runCanaryRollout({
    ...fixture,
    collectMetrics: async () => ({ errorRate: 0.001, p99LatencyMs: 200 }),
    audit: (entry) => audit.push(entry),
  });
  assert.equal(result.promoted, true);
  assert.equal(result.rolledBack, false);
  assert.equal(result.digest, fixture.canaryDigest);
  assert.ok(audit.some((entry) => entry.action === 'promote'));
});

test('canary rollout halts and rolls back when latency or error thresholds breach', async () => {
  const fixture = makeCanaryFixture();

  const latency = await runCanaryRollout({
    ...fixture,
    collectMetrics: async () => ({ errorRate: 0.0, p99LatencyMs: 900 }),
    audit: () => {},
  });
  assert.equal(latency.promoted, false);
  assert.equal(latency.rolledBack, true);
  assert.equal(latency.digest, fixture.baselineDigest);
  assert.match(latency.reason, /latency/);

  const errors = await runCanaryRollout({
    ...fixture,
    collectMetrics: async () => ({ errorRate: 0.5, p99LatencyMs: 100 }),
    audit: () => {},
  });
  assert.equal(errors.promoted, false);
  assert.equal(errors.rolledBack, true);
  assert.match(errors.reason, /error/);
});

test('canary rollout records an audited manual override', async () => {
  const fixture = makeCanaryFixture();
  const audit = [];
  const result = await runCanaryRollout({
    ...fixture,
    collectMetrics: async () => ({ errorRate: 0.5, p99LatencyMs: 900 }),
    override: { approver: 'dave', reason: 'known upstream incident' },
    audit: (entry) => audit.push(entry),
  });
  assert.equal(result.promoted, true);
  assert.equal(result.overridden, true);
  assert.ok(audit.some((entry) => entry.action === 'override' && entry.approver === 'dave'));

  await assert.rejects(
    runCanaryRollout({
      ...fixture,
      collectMetrics: async () => ({ errorRate: 0, p99LatencyMs: 100 }),
      override: { reason: 'no approver' },
      audit: () => {},
    }),
    /approver/
  );
});

test('canary rollout is safe under concurrent invocation for the same deployment', async () => {
  const fixture = makeCanaryFixture();
  let promotions = 0;
  const options = {
    ...fixture,
    collectMetrics: async () => ({ errorRate: 0, p99LatencyMs: 100 }),
    audit: () => {},
    promote: async () => {
      promotions += 1;
    },
  };

  const [first, second] = await Promise.all([
    runCanaryRollout(options),
    runCanaryRollout(options),
  ]);
  assert.equal(promotions, 1);
  assert.equal(first.promoted, true);
  assert.equal(second.promoted, true);
  assert.equal(first.digest, second.digest);
});
