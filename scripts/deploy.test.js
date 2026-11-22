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
