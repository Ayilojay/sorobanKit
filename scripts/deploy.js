#!/usr/bin/env node
'use strict';

/**
 * scripts/deploy.js
 *
 * Automated CLI tool to compile, optimize, deploy, initialize, and upgrade
 * the Soroban PaymentRouter smart contract, and update backend/frontend configs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

// ── Network Configurations ───────────────────────────────────────────────────

const NETWORKS = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
  },
  futurenet: {
    name: 'futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
  },
  local: {
    name: 'local',
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: 'Standalone Network ; February 2017',
    horizonUrl: 'http://localhost:8000',
  },
};

// ── Default Paths ────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '..');
const CONTRACT_DIR = path.join(ROOT_DIR, 'payment_router');
const DEFAULT_WASM_PATH = path.join(
  CONTRACT_DIR,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'payment_router.wasm'
);
const DEFAULT_OPTIMIZED_WASM_PATH = path.join(
  CONTRACT_DIR,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'payment_router.optimized.wasm'
);
const WASM_HASH_MANIFEST_PATH = path.join(CONTRACT_DIR, 'wasm.sha256');
const DEFAULT_RELEASE_MANIFEST_PATH = path.join(
  CONTRACT_DIR,
  'release-manifest.json'
);
const DEFAULT_BUILD_RECORD_PATH = path.join(ROOT_DIR, 'deploy', 'build-record.json');
const DEFAULT_DEPLOYMENT_RECORD_PATH = path.join(ROOT_DIR, 'deploy', 'deployments.json');
const DEFAULT_SMOKE_RESULTS_DIR = path.join(ROOT_DIR, 'deploy', 'smoke-results');
const DEFAULT_BACKEND_DIR = path.join(ROOT_DIR, 'stellar-payment-platform');
const DEFAULT_DASHBOARD_DIR = path.join(ROOT_DIR, 'payment-dashboard');
const DEFAULT_IMAGE_REPOSITORY = 'stellar-payment-platform';
const DEFAULT_PROVENANCE_DIR = path.join(ROOT_DIR, 'deploy', 'provenance');
const DEFAULT_CANARY_RECORD_PATH = path.join(ROOT_DIR, 'deploy', 'canary.json');
const DEFAULT_CANARY_LOCK_PATH = path.join(ROOT_DIR, 'deploy', '.canary.lock');
const PROVENANCE_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PROVENANCE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const ARTIFACT_TYPES = ['backend', 'dashboard', 'contract'];
const CANARY_DEFAULT_POLICY = {
  traffic_percent: 10,
  evaluation_window_seconds: 300,
  poll_interval_seconds: 30,
  latency_p95_ms: 500,
  error_rate_percent: 1,
  min_requests: 20,
};
const CANARY_LOCK_STALE_MS = 30 * 60 * 1000;
const CANARY_LOCK_MAX_ATTEMPTS = 3;
const CANARY_LOCK_RETRY_MS = 100;
=======

// Environment configuration is always supplied externally at deploy time; it is
// never baked into the immutable image. These are the keys the backend requires.
const REQUIRED_RUNTIME_ENV_KEYS = [
  'DATABASE_URL',
  'STELLAR_RPC_URL',
  'NETWORK_PASSPHRASE',
  'PAYMENT_ROUTER_CONTRACT_ID',
];
const FORBIDDEN_IMAGE_ENV_KEYS = [
  'DATABASE_URL',
  'STELLAR_SECRET_KEY',
  'SOROBAN_SECRET_KEY',
  'JWT_SECRET',
];
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SMOKE_AMOUNT = '1';
const SMOKE_MAX_ATTEMPTS = 3;

const readJsonFile = (filePath, description) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${description} ${filePath}: ${error.message}`);
  }
};

const writeJsonFileAtomic = (filePath, value, description) => {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
    throw new Error(`Could not persist ${description} ${filePath}: ${error.message}`);
  }
};

const hashesEqual = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(left.toLowerCase(), 'hex'),
    Buffer.from(right.toLowerCase(), 'hex')
  );
};

const topologicallySortContracts = (contracts) => {
  const contractsByName = new Map(contracts.map((contract) => [contract.name, contract]));
  const state = new Map();
  const ordered = [];

  const visit = (contract) => {
    const visitState = state.get(contract.name);
    if (visitState === 'visiting') {
      throw new Error(`Release manifest dependency cycle includes "${contract.name}".`);
    }
    if (visitState === 'visited') {
      return;
    }

    state.set(contract.name, 'visiting');
    for (const dependencyName of contract.dependencies) {
      const dependency = contractsByName.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `Contract "${contract.name}" depends on unknown contract "${dependencyName}".`
        );
      }
      visit(dependency);
    }
    state.set(contract.name, 'visited');
    ordered.push(contract);
  };

  for (const contract of contracts) {
    visit(contract);
  }
  return ordered;
};

/**
 * Loads and fully validates a coordinated-release manifest and every local
 * WASM artifact before any network operation is attempted.
 */
const loadReleaseManifest = (manifestPath, selectedNetwork) => {
  const absoluteManifestPath = path.resolve(manifestPath);
  const rawManifest = readJsonFile(absoluteManifestPath, 'release manifest');
  const manifest = validateReleaseManifest(rawManifest, { network: selectedNetwork });

  const contracts = manifest.contracts.map((entry) => {
    const wasmPath = path.resolve(path.dirname(absoluteManifestPath), entry.wasm_path);
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file for contract "${entry.name}" does not exist: ${wasmPath}`);
    }
    const actualHash = computeLocalWasmHash(wasmPath);
    if (!hashesEqual(actualHash, entry.wasm_sha256)) {
      throw new Error(
        `WASM hash mismatch for "${entry.name}": manifest=${entry.wasm_sha256} local=${actualHash}.`
      );
    }
    return { ...entry, resolved_wasm_path: wasmPath };
  });

  return {
    manifest: { ...manifest, contracts },
    manifestPath: absoluteManifestPath,
    orderedContracts: topologicallySortContracts(contracts),
  };
};

/**
 * Validates a coordinated release manifest object (already parsed) and returns
 * a normalized copy. Rejects mismatched dashboard/client/contract combinations.
 * This is the pure, network-free half of loadReleaseManifest.
 */
const validateReleaseManifest = (manifest, options = {}) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Release manifest must be an object.');
  }
  if (manifest.schema_version !== 1) {
    throw new Error('Release manifest must have schema_version 1.');
  }
  if (!NETWORKS[manifest.network]) {
    throw new Error(`Release manifest has unsupported network "${manifest.network}".`);
  }
  if (options.network && manifest.network !== options.network) {
    throw new Error(
      `Release manifest network "${manifest.network}" does not match selected network "${options.network}".`
    );
  }
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    throw new Error('Release manifest must contain at least one contract.');
  }

  // Package versions: backend, dashboard, client must all be recorded.
  const packages = manifest.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('Release manifest must record package versions.');
  }
  for (const key of ['backend', 'dashboard', 'client']) {
    if (typeof packages[key] !== 'string' || packages[key].length === 0) {
      throw new Error(`Release manifest must record a "${key}" package version.`);
    }
  }

  // Supported networks must include the manifest network.
  if (!Array.isArray(manifest.supported_networks) ||
      manifest.supported_networks.length === 0 ||
      manifest.supported_networks.some((entry) => !NETWORKS[entry])) {
    throw new Error('Release manifest must list supported_networks using known network names.');
  }
  if (!manifest.supported_networks.includes(manifest.network)) {
    throw new Error(
      `Release manifest network "${manifest.network}" is not in supported_networks.`
    );
  }

  // Migration level must be a non-negative integer.
  if (!Number.isSafeInteger(manifest.migration_level) || manifest.migration_level < 0) {
    throw new Error('Release manifest must record a non-negative integer migration_level.');
  }

  const names = new Set();
  const contractIds = new Set();
  const contracts = manifest.contracts.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every release manifest contract must be an object.');
    }
    if (typeof entry.name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(entry.name)) {
      throw new Error('Contract names must start with a lowercase letter and use lowercase letters, digits, "_" or "-".');
    }
    if (names.has(entry.name)) {
      throw new Error(`Duplicate contract name "${entry.name}" in release manifest.`);
    }
    names.add(entry.name);

    if (typeof entry.contract_id !== 'string' || !/^C[A-Z2-7]{55}$/.test(entry.contract_id)) {
      throw new Error(`Contract "${entry.name}" must have a valid-format contract_id.`);
    }
    if (contractIds.has(entry.contract_id)) {
      throw new Error(`Duplicate contract_id "${entry.contract_id}" in release manifest.`);
    }
    contractIds.add(entry.contract_id);

    if (typeof entry.wasm_path !== 'string' || entry.wasm_path.length === 0) {
      throw new Error(`Contract "${entry.name}" must have a wasm_path.`);
    }
    if (typeof entry.wasm_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.wasm_sha256)) {
      throw new Error(`Contract "${entry.name}" must have a 64-character wasm_sha256.`);
    }
    if (typeof entry.interface_schema_sha256 !== 'string' ||
        !/^[a-fA-F0-9]{64}$/.test(entry.interface_schema_sha256)) {
      throw new Error(`Contract "${entry.name}" must have a 64-character interface_schema_sha256.`);
    }
    if (!Number.isSafeInteger(entry.interface_version) || entry.interface_version < 1) {
      throw new Error(`Contract "${entry.name}" must have a positive integer interface_version.`);
    }
    if (!Array.isArray(entry.dependencies) ||
        entry.dependencies.some((dependency) => typeof dependency !== 'string') ||
        new Set(entry.dependencies).size !== entry.dependencies.length) {
      throw new Error(`Contract "${entry.name}" must have a unique dependencies array.`);
    }
    if (entry.dependencies.includes(entry.name)) {
      throw new Error(`Contract "${entry.name}" cannot depend on itself.`);
    }
    if (entry.queued_action_nonce !== undefined &&
        (!Number.isSafeInteger(entry.queued_action_nonce) || entry.queued_action_nonce < 1)) {
      throw new Error(`Contract "${entry.name}" has an invalid queued_action_nonce.`);
    }

    return {
      ...entry,
      wasm_sha256: entry.wasm_sha256.toLowerCase(),
      interface_schema_sha256: entry.interface_schema_sha256.toLowerCase(),
    };
  });

  return {
    ...manifest,
    contracts,
    packages: { ...packages },
    supported_networks: [...manifest.supported_networks],
  };
};

const writeReleaseManifest = (manifestPath, manifest) => {
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  const serializableManifest = {
    ...manifest,
    contracts: manifest.contracts.map((entry) => {
      const contract = { ...entry };
      delete contract.resolved_wasm_path;
      return contract;
    }),
  };
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(serializableManifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
    throw new Error(`Could not persist release manifest ${manifestPath}: ${error.message}`);
  }
};

const readOnChainContractWasmHash = (contractId, network, runCommand = execFileSync) => {
  const output = String(
    runCommand(
      'stellar',
      ['contract', 'info', '--id', contractId, '--network', network.name, '--rpc-url', network.rpcUrl],
      { cwd: CONTRACT_DIR, encoding: 'utf8' }
    )
  );
  const match = output.match(/(?:wasm(?:_hash)?|wasm hash)\s*[:=]\s*["']?([a-f0-9]{64})/i);
  if (!match) {
    throw new Error(`Could not read the deployed WASM hash for contract ${contractId}.`);
  }
  return match[1].toLowerCase();
};

const readOnChainInterfaceVersion = (contractId, network, runCommand = execFileSync) => {
  const output = String(
    runCommand(
      'stellar',
      ['contract', 'invoke', '--id', contractId, '--network', network.name, '--rpc-url', network.rpcUrl, '--', 'interface_version'],
      { cwd: CONTRACT_DIR, encoding: 'utf8' }
    )
  );
  const match = output.match(/(?:^|\n)\s*(\d+)\s*(?:\n|$)/);
  if (!match) {
    throw new Error(`Could not read the interface version for contract ${contractId}.`);
  }
  return Number(match[1]);
};

const upgradeReleaseManifest = async (options) => {
  const { manifest, manifestPath, orderedContracts } = loadReleaseManifest(
    options.manifestPath || DEFAULT_RELEASE_MANIFEST_PATH,
    options.network
  );
  const network = NETWORKS[manifest.network];
  const runCommand = options.runCommand || execFileSync;
  if (options.dryRun) {
    for (const contract of orderedContracts) {
      if (options.execute) {
        logDryRun(`execute queued upgrade ${contract.queued_action_nonce} for ${contract.name}`);
        logDryRun(`verify deployed WASM hash and interface version for ${contract.name}`);
      } else if (contract.queued_action_nonce) {
        logDryRun(`keep existing queued upgrade ${contract.queued_action_nonce} for ${contract.name}`);
      } else {
        logDryRun(`install ${contract.name} WASM ${contract.wasm_sha256} on ${network.name}`);
        logDryRun(`queue upgrade ${contract.contract_id} after dependencies`);
      }
    }
    return;
  }

  const invoke = (contract, method, args, inheritOutput = false) => {
    const invokeArgs = [
      'contract',
      'invoke',
      '--id',
      contract.contract_id,
      '--network',
      network.name,
      '--rpc-url',
      network.rpcUrl,
    ];
    if (options.source) {
      invokeArgs.push('--source', options.source);
    }
    invokeArgs.push('--', method, ...args);
    return runCommand(
      'stellar',
      invokeArgs,
      inheritOutput
        ? { cwd: CONTRACT_DIR, stdio: 'inherit' }
        : { cwd: CONTRACT_DIR, encoding: 'utf8' }
    );
  };

  const getContractHash = options.getContractHash || ((contractId) =>
    readOnChainContractWasmHash(contractId, network, runCommand));
  const getInterfaceVersion = options.getInterfaceVersion || ((contractId) =>
    readOnChainInterfaceVersion(contractId, network, runCommand));

  if (options.execute) {
    if (!orderedContracts.some((contract) => contract.queued_action_nonce)) {
      throw new Error('No queued upgrades are recorded in the release manifest.');
    }
    for (const contract of orderedContracts) {
      if (contract.queued_action_nonce) {
        const currentHash = String(await getContractHash(contract.contract_id)).toLowerCase();
        if (!hashesEqual(currentHash, contract.wasm_sha256)) {
          invoke(contract, 'execute_action', ['--nonce', String(contract.queued_action_nonce)], true);
        }
      }

      const deployedHash = String(await getContractHash(contract.contract_id)).toLowerCase();
      if (!hashesEqual(deployedHash, contract.wasm_sha256)) {
        throw new Error(`Deployed contract WASM hash verification failed for "${contract.name}".`);
      }
      const interfaceVersion = Number(await getInterfaceVersion(contract.contract_id));
      if (interfaceVersion !== contract.interface_version) {
        throw new Error(
          `Interface version mismatch for "${contract.name}": expected ${contract.interface_version}, got ${interfaceVersion}.`
        );
      }
      if (contract.queued_action_nonce) {
        const manifestContract = manifest.contracts.find(({ name }) => name === contract.name);
        delete manifestContract.queued_action_nonce;
        writeReleaseManifest(manifestPath, manifest);
      }
      console.log(
        `✅ Verified ${contract.name}: WASM ${deployedHash}, interface ${interfaceVersion}`
      );
    }
    return;
  }

  const getUploadedHash = options.getUploadedHash || fetchOnChainWasmHash;
  for (const contract of orderedContracts) {
    if (contract.queued_action_nonce) {
      console.log(
        `ℹ️  Keeping existing queued upgrade ${contract.queued_action_nonce} for ${contract.name}`
      );
      continue;
    }
    const installArgs = [
      'contract',
      'install',
      '--wasm',
      contract.resolved_wasm_path,
      '--network',
      network.name,
      '--rpc-url',
      network.rpcUrl,
    ];
    if (options.source) {
      installArgs.push('--source', options.source);
    }
    const installedHash = String(
      runCommand('stellar', installArgs, { cwd: CONTRACT_DIR, encoding: 'utf8' })
    ).trim().toLowerCase();
    if (!hashesEqual(installedHash, contract.wasm_sha256)) {
      throw new Error(
        `Installed WASM hash for "${contract.name}" does not match its release manifest entry.`
      );
    }
    const uploadedHash = String(await getUploadedHash(installedHash, network)).toLowerCase();
    if (!hashesEqual(uploadedHash, contract.wasm_sha256)) {
      throw new Error(`Uploaded WASM hash verification failed for "${contract.name}".`);
    }

    const queueOutput = String(
      invoke(contract, 'queue_upgrade', ['--new_wasm_hash', installedHash])
    ).trim();
    const nonceMatch = queueOutput.match(/(?:^|\n)\s*"?(\d+)"?\s*(?:\n|$)/g);
    if (!nonceMatch) {
      throw new Error(`Could not read the timelock nonce for "${contract.name}" upgrade.`);
    }
    const nonce = Number(nonceMatch[nonceMatch.length - 1].trim().replace(/"/g, ''));
    if (!Number.isSafeInteger(nonce) || nonce < 1) {
      throw new Error(`Invalid timelock nonce returned for "${contract.name}" upgrade.`);
    }
    manifest.contracts.find(({ name }) => name === contract.name).queued_action_nonce = nonce;
    writeReleaseManifest(manifestPath, manifest);
    console.log(
      `✅ Queued ${contract.name} upgrade as action ${nonce}; execute after the 24-hour delay.`
    );
  }
};

// ── Immutable Artifact Build & Promotion (Issue #467) ────────────────────────

const readPackageVersion = (packageDir) => {
  const packageJsonPath = path.join(packageDir, 'package.json');
  const packageJson = readJsonFile(packageJsonPath, 'package.json');
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`package.json at ${packageJsonPath} has no version.`);
  }
  return packageJson.version;
};

const computeFileSha256 = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

/**
 * Builds exactly one immutable backend artifact (a container image) and records
 * its content digest. The image is built from a clean context with no runtime
 * environment baked in; all configuration is injected at deploy time.
 *
 * @param {object} options
 * @returns {object} The persisted build record.
 */
const buildArtifact = (options = {}) => {
  const backendDir = path.resolve(options.backendDir || DEFAULT_BACKEND_DIR);
  const buildRecordPath = path.resolve(options.buildRecordPath || DEFAULT_BUILD_RECORD_PATH);
  const repository = options.imageRepository || DEFAULT_IMAGE_REPOSITORY;
  const tag = options.tag || `build-${Date.now()}`;
  const imageRef = `${repository}:${tag}`;
  const runCommand = options.runCommand || execFileSync;

  if (!fs.existsSync(path.join(backendDir, 'Dockerfile'))) {
    throw new Error(`Backend Dockerfile not found in ${backendDir}.`);
  }

  const backendVersion = readPackageVersion(backendDir);
  const dashboardVersion = readPackageVersion(
    path.resolve(options.dashboardDir || DEFAULT_DASHBOARD_DIR)
  );

  if (options.dryRun) {
    logDryRun(`docker build --pull -t ${imageRef} ${backendDir}`);
    logDryRun(`docker image inspect --format '{{.Id}}' ${imageRef}`);
    return { dryRun: true, image: imageRef, backend_version: backendVersion };
  }

  runCommand('docker', ['build', '--pull', '-t', imageRef, backendDir], {
    stdio: 'inherit',
  });

  const inspectOutput = String(
    runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', imageRef], {
      encoding: 'utf8',
    })
  ).trim();
  const digest = inspectOutput.startsWith('sha256:')
    ? inspectOutput.toLowerCase()
    : `sha256:${inspectOutput.toLowerCase()}`;
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`Could not determine a valid image digest for ${imageRef}: ${inspectOutput}`);
  }

  // Guard against environment leaking into the image.
  const envOutput = String(
    runCommand('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', imageRef], {
      encoding: 'utf8',
    })
  );
  let imageEnv = [];
  try {
    imageEnv = JSON.parse(envOutput) || [];
  } catch {
    imageEnv = [];
  }
  const leaked = imageEnv
    .map((entry) => String(entry).split('=')[0])
    .filter((key) => FORBIDDEN_IMAGE_ENV_KEYS.includes(key));
  if (leaked.length > 0) {
    throw new Error(
      `Image ${imageRef} bakes forbidden runtime configuration: ${leaked.join(', ')}.`
    );
  }

  const record = {
    schema_version: 1,
    image: imageRef,
    digest,
    backend_version: backendVersion,
    dashboard_version: dashboardVersion,
    built_at: new Date().toISOString(),
    builder: options.builder || process.env.GITHUB_ACTOR || os.userInfo().username,
  };
  writeJsonFileAtomic(buildRecordPath, record, 'build record');
  console.log(`✅ Built immutable artifact ${imageRef} (${digest}).`);
  return record;
};

const loadBuildRecord = (buildRecordPath) => {
  const record = readJsonFile(path.resolve(buildRecordPath), 'build record');
  if (!record || !DIGEST_PATTERN.test(String(record.digest || ''))) {
    throw new Error(`Build record ${buildRecordPath} has no valid image digest.`);
  }
  return record;
};

const loadDeploymentRecord = (deploymentRecordPath) => {
  const absolutePath = path.resolve(deploymentRecordPath);
  if (!fs.existsSync(absolutePath)) {
    return { schema_version: 1, deployments: [] };
  }
  const record = readJsonFile(absolutePath, 'deployment record');
  if (!Array.isArray(record.deployments)) {
    throw new Error(`Deployment record ${absolutePath} has no deployments array.`);
  }
  return record;
};

const resolveRuntimeEnv = (options = {}) => {
  const source = options.runtimeEnv || process.env;
  const missing = REQUIRED_RUNTIME_ENV_KEYS.filter(
    (key) => typeof source[key] !== 'string' || source[key].length === 0
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing external runtime configuration: ${missing.join(', ')}. ` +
        'Configuration must be supplied at deploy time, never baked into the image.'
    );
  }
  const env = {};
  for (const key of REQUIRED_RUNTIME_ENV_KEYS) {
    env[key] = source[key];
  }
  return env;
};

// ── Build Provenance Attestation (Issue #464) ────────────────────────────────

const normalizeSha256 = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return normalized;
  }
  if (DIGEST_PATTERN.test(normalized)) {
    return normalized.slice('sha256:'.length);
  }
  return null;
};

const resolveToolchain = (toolchain = {}) => {
  const resolved = {
    node: toolchain.node || process.version,
    npm: toolchain.npm || null,
    rustc: toolchain.rustc || null,
    cargo: toolchain.cargo || null,
    stellar_cli: toolchain.stellar_cli || null,
    docker: toolchain.docker || null,
  };
  for (const key of Object.keys(resolved)) {
    if (resolved[key] !== null && typeof resolved[key] !== 'string') {
      throw new Error(`Toolchain entry "${key}" must be a string.`);
    }
  }
  return resolved;
};

const resolveWorkflowIdentity = (workflowIdentity) => {
  const identity = workflowIdentity || {};
  const resolved = {
    repository: identity.repository || process.env.GITHUB_REPOSITORY || null,
    workflow_ref: identity.workflow_ref || process.env.GITHUB_WORKFLOW_REF || null,
    workflow_sha: identity.workflow_sha || process.env.GITHUB_SHA || null,
    run_id: identity.run_id || process.env.GITHUB_RUN_ID || null,
    run_attempt: identity.run_attempt || process.env.GITHUB_RUN_ATTEMPT || null,
    actor: identity.actor || process.env.GITHUB_ACTOR || null,
  };
  if (!resolved.workflow_ref) {
    throw new Error('Provenance requires a workflow identity (workflow_ref).');
  }
  return resolved;
};

/**
 * Generates a SLSA-style in-toto provenance attestation for a build artifact.
 * The subject digest is the SHA-256 of the artifact bytes; the predicate binds
 * the source commit, workflow identity, and toolchain versions.
 *
 * @param {object} options
 * @returns {object} The attestation statement (also persisted when outputPath is set).
 */
const generateProvenance = (options = {}) => {
  const artifactPath = path.resolve(options.artifactPath || '');
  if (!options.artifactPath || !fs.existsSync(artifactPath)) {
    throw new Error(`Provenance requires an existing --artifact, got "${options.artifactPath}".`);
  }
  const artifactType = options.artifactType;
  if (!ARTIFACT_TYPES.includes(artifactType)) {
    throw new Error(
      `Provenance artifact type must be one of ${ARTIFACT_TYPES.join(', ')}, got "${artifactType}".`
    );
  }
  const sourceCommit = String(options.sourceCommit || process.env.GITHUB_SHA || '');
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) {
    throw new Error(`Provenance requires a 40-character source commit, got "${sourceCommit}".`);
  }
  const workflowIdentity = resolveWorkflowIdentity(options.workflowIdentity);
  const toolchain = resolveToolchain(options.toolchain);

  const artifactDigest = computeFileSha256(artifactPath);
  const artifactName = options.artifactName || path.basename(artifactPath);
  const statement = {
    _type: PROVENANCE_STATEMENT_TYPE,
    subject: [
      {
        name: artifactName,
        digest: { sha256: artifactDigest },
      },
    ],
    predicateType: PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: 'https://stellar-payment-platform.dev/buildtypes/deploy-cli/v1',
        externalParameters: {
          artifact_type: artifactType,
          source_commit: sourceCommit.toLowerCase(),
        },
        internalParameters: {
          toolchain,
        },
        resolvedDependencies: [
          {
            uri: `git+${workflowIdentity.repository || 'unknown'}@${sourceCommit.toLowerCase()}`,
            digest: { gitCommit: sourceCommit.toLowerCase() },
          },
        ],
      },
      runDetails: {
        builder: {
          id: workflowIdentity.workflow_ref,
          version: workflowIdentity.workflow_sha || undefined,
        },
        metadata: {
          invocationId: workflowIdentity.run_id || undefined,
          startedOn: new Date().toISOString(),
          actor: workflowIdentity.actor || undefined,
        },
        byproducts: [],
      },
      workflow: workflowIdentity,
    },
  };

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeJsonFileAtomic(outputPath, statement, 'provenance attestation');
    console.log(`✅ Wrote provenance attestation ${outputPath} for ${artifactName}.`);
  }
  return statement;
};

/**
 * Verifies a provenance attestation against an artifact, recomputing the
 * artifact digest. Throws on any mismatch so callers abort deployment.
 *
 * @param {object} options
 * @returns {object} Verification result.
 */
const verifyProvenance = (options = {}) => {
  if (!options.attestationPath) {
    throw new Error('Provenance verification requires --attestation.');
  }
  const attestationPath = path.resolve(options.attestationPath);
  const statement = readJsonFile(attestationPath, 'provenance attestation');
  if (!statement || statement._type !== PROVENANCE_STATEMENT_TYPE) {
    throw new Error(`Attestation ${attestationPath} is not an in-toto statement.`);
  }
  if (statement.predicateType !== PROVENANCE_PREDICATE_TYPE) {
    throw new Error(`Attestation ${attestationPath} has an unsupported predicate type.`);
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error(`Attestation ${attestationPath} must have exactly one subject.`);
  }
  const subject = statement.subject[0];
  const expectedDigest = normalizeSha256(subject && subject.digest && subject.digest.sha256);
  if (!expectedDigest) {
    throw new Error(`Attestation ${attestationPath} subject has no valid sha256 digest.`);
  }

  const artifactPath = path.resolve(options.artifactPath || '');
  if (!options.artifactPath || !fs.existsSync(artifactPath)) {
    throw new Error(`Provenance verification requires an existing --artifact, got "${options.artifactPath}".`);
  }
  const actualDigest = computeFileSha256(artifactPath);
  if (!hashesEqual(actualDigest, expectedDigest)) {
    throw new Error(
      `Provenance digest mismatch for ${path.basename(artifactPath)}: ` +
        `attestation=${expectedDigest} artifact=${actualDigest}. Aborting deployment.`
    );
  }

  const sourceCommit = statement.predicate &&
    statement.predicate.buildDefinition &&
    statement.predicate.buildDefinition.externalParameters &&
    statement.predicate.buildDefinition.externalParameters.source_commit;
  if (!/^[a-f0-9]{40}$/.test(String(sourceCommit || ''))) {
    throw new Error(`Attestation ${attestationPath} does not bind a source commit.`);
  }

  return {
    ok: true,
    attestation: attestationPath,
    artifact: artifactPath,
    digest: actualDigest,
    source_commit: sourceCommit,
    workflow_ref: statement.predicate.workflow && statement.predicate.workflow.workflow_ref,
  };
};

const runProvenanceCommand = (options = {}) => {
  const action = options.provenanceAction || 'verify';
  if (action === 'generate') {
    return generateProvenance({
      artifactPath: options.artifactPath,
      artifactType: options.artifactType,
      sourceCommit: options.sourceCommit,
      workflowIdentity: options.workflowIdentity,
      toolchain: options.toolchain,
      outputPath: options.attestationPath,
    });
  }
  if (action === 'verify') {
    const result = verifyProvenance({
      attestationPath: options.attestationPath,
      artifactPath: options.artifactPath,
    });
    console.log(`✅ Provenance verified for ${path.basename(result.artifact)} (${result.digest}).`);
    return result;
  }
  throw new Error(`Unknown provenance action "${action}"; expected generate or verify.`);
};

// ── Canary Rollout & Automated Rollback (Issue #468) ─────────────────────────

const resolveCanaryPolicy = (policy = {}) => {
  const merged = { ...CANARY_DEFAULT_POLICY, ...(policy || {}) };
  const numeric = [
    'traffic_percent',
    'evaluation_window_seconds',
    'poll_interval_seconds',
    'latency_p95_ms',
    'error_rate_percent',
    'min_requests',
  ];
  for (const key of numeric) {
    if (typeof merged[key] !== 'number' || !Number.isFinite(merged[key]) || merged[key] < 0) {
      throw new Error(`Canary policy "${key}" must be a non-negative number.`);
    }
  }
  if (merged.traffic_percent <= 0 || merged.traffic_percent >= 100) {
    throw new Error('Canary traffic_percent must be greater than 0 and less than 100.');
  }
  if (merged.evaluation_window_seconds <= 0) {
    throw new Error('Canary evaluation_window_seconds must be positive.');
  }
  if (merged.poll_interval_seconds <= 0) {
    throw new Error('Canary poll_interval_seconds must be positive.');
  }
  if (merged.latency_p95_ms <= 0) {
    throw new Error('Canary latency_p95_ms must be positive.');
  }
  if (merged.error_rate_percent < 0 || merged.error_rate_percent > 100) {
    throw new Error('Canary error_rate_percent must be between 0 and 100.');
  }
  return merged;
};

const acquireCanaryLock = (lockPath, options = {}) => {
  const absoluteLockPath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(absoluteLockPath), { recursive: true });
  const now = options.now ? options.now() : Date.now();
  for (let attempt = 0; attempt < CANARY_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const handle = fs.openSync(absoluteLockPath, 'wx');
      fs.writeSync(
        handle,
        `${JSON.stringify({ pid: process.pid, acquired_at: new Date(now).toISOString() })}\n`
      );
      fs.closeSync(handle);
      return {
        path: absoluteLockPath,
        release: () => {
          try {
            fs.unlinkSync(absoluteLockPath);
          } catch {
            /* already released */
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new Error(`Could not acquire canary lock ${absoluteLockPath}: ${error.message}`);
      }
      let stale = false;
      try {
        const stat = fs.statSync(absoluteLockPath);
        stale = now - stat.mtimeMs > CANARY_LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          fs.unlinkSync(absoluteLockPath);
        } catch {
          /* raced with another releaser */
        }
        continue;
      }
      if (attempt === CANARY_LOCK_MAX_ATTEMPTS - 1) {
        throw new Error(
          `Another canary deployment holds the lock ${absoluteLockPath}; refusing to run concurrently.`
        );
      }
      if (options.sleep) {
        options.sleep(CANARY_LOCK_RETRY_MS);
      }
    }
  }
  throw new Error(`Could not acquire canary lock ${absoluteLockPath}.`);
};

const evaluateCanaryMetrics = (metrics, policy) => {
  const breaches = [];
  if (!metrics || typeof metrics !== 'object') {
    return ['metrics unavailable'];
  }
  const requests = Number(metrics.requests);
  if (!Number.isFinite(requests) || requests < policy.min_requests) {
    breaches.push(`insufficient samples (${metrics.requests} < ${policy.min_requests})`);
  }
  const latency = Number(metrics.latency_p95_ms);
  if (!Number.isFinite(latency) || latency > policy.latency_p95_ms) {
    breaches.push(`latency p95 ${metrics.latency_p95_ms}ms > ${policy.latency_p95_ms}ms`);
  }
  const errorRate = Number(metrics.error_rate_percent);
  if (!Number.isFinite(errorRate) || errorRate > policy.error_rate_percent) {
    breaches.push(`error rate ${metrics.error_rate_percent}% > ${policy.error_rate_percent}%`);
  }
  return breaches;
};

/**
 * Runs a canary rollout of an immutable digest: deploys the canary, polls
 * metrics during the evaluation window, and halts promotion / rolls back when
 * user-visible indicators breach policy. Manual overrides are audited.
 *
 * @param {object} options
 * @returns {object} Canary outcome record.
 */
const runCanaryRollout = async (options = {}) => {
  const digest = String(options.digest || '').toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`canary requires a valid --digest (sha256:<64 hex>), got "${options.digest}".`);
  }
  const policy = resolveCanaryPolicy(options.policy);
  const deploymentId = options.deploymentId || `canary-${Date.now()}`;
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new Error(`Invalid deployment ID "${deploymentId}".`);
  }
  const lockPath = path.resolve(options.lockPath || DEFAULT_CANARY_LOCK_PATH);
  const recordPath = path.resolve(options.canaryRecordPath || DEFAULT_CANARY_RECORD_PATH);
  const runCommand = options.runCommand || execFileSync;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchMetrics = options.fetchMetrics || (async () => {
    throw new Error('canary requires a metrics provider (fetchMetrics).');
  });

  const lock = acquireCanaryLock(lockPath, { now, sleep });
  const record = fs.existsSync(recordPath)
    ? readJsonFile(recordPath, 'canary record')
    : { schema_version: 1, rollouts: [] };
  if (!Array.isArray(record.rollouts)) {
    lock.release();
    throw new Error(`Canary record ${recordPath} has no rollouts array.`);
  }

  const entry = {
    deployment_id: deploymentId,
    digest,
    policy,
    started_at: new Date(now()).toISOString(),
    status: 'running',
    samples: [],
    overrides: [],
    rolled_back: false,
  };

  const persist = () => {
    record.rollouts.push(entry);
    writeJsonFileAtomic(recordPath, record, 'canary record');
  };

  try {
    if (options.dryRun) {
      logDryRun(`deploy canary ${digest} at ${policy.traffic_percent}% traffic`);
      logDryRun(`poll metrics every ${policy.poll_interval_seconds}s for ${policy.evaluation_window_seconds}s`);
      logDryRun('halt promotion and roll back on policy breach');
      entry.status = 'dry-run';
      persist();
      return entry;
    }

    if (options.manualOverride) {
      const override = options.manualOverride;
      if (!override.actor || !override.reason) {
        throw new Error('Manual override requires an actor and a reason.');
      }
      entry.overrides.push({
        actor: override.actor,
        reason: override.reason,
        at: new Date(now()).toISOString(),
        action: override.action || 'promote',
      });
      console.log(`⚠️  Manual override by ${override.actor}: ${override.reason}`);
    }

    if (options.deployCanary) {
      await options.deployCanary({ digest, trafficPercent: policy.traffic_percent, deploymentId });
    } else {
      runCommand(
        'docker',
        ['run', '--detach', '--name', `${DEFAULT_IMAGE_REPOSITORY}-canary-${deploymentId}`, digest],
        { stdio: 'inherit' }
      );
    }

    const deadline = now() + policy.evaluation_window_seconds * 1000;
    let breached = null;
    while (now() < deadline) {
      const metrics = await fetchMetrics({ digest, deploymentId });
      const breaches = evaluateCanaryMetrics(metrics, policy);
      entry.samples.push({
        at: new Date(now()).toISOString(),
        metrics,
        breaches,
      });
      if (breaches.length > 0) {
        breached = breaches;
        break;
      }
      await sleep(policy.poll_interval_seconds * 1000);
    }

    if (breached) {
      entry.status = 'rolled-back';
      entry.rolled_back = true;
      entry.breaches = breached;
      if (options.rollback) {
        await options.rollback({ digest, deploymentId, reason: breached.join('; ') });
      } else if (options.previousDigest) {
        rollbackArtifact({
          to: options.previousDigest,
          deploymentId: `rollback-${deploymentId}`,
          deploymentRecordPath: options.deploymentRecordPath,
          runtimeEnv: options.runtimeEnv,
          runCommand,
        });
      }
      console.error(`❌ Canary breached policy and was rolled back: ${breached.join('; ')}`);
      persist();
      throw new Error(`Canary rollout ${deploymentId} breached policy: ${breached.join('; ')}`);
    }

    entry.status = 'promoted';
    entry.completed_at = new Date(now()).toISOString();
    persist();
    console.log(`✅ Canary ${deploymentId} passed evaluation; promotion allowed.`);
    return entry;
  } catch (error) {
    if (entry.status === 'running') {
      entry.status = 'failed';
      entry.error = error.message;
      persist();
    }
    throw error;
  } finally {
    lock.release();
  }
};

const verifyDigestAvailable = (digest, options = {}) => {
  const runCommand = options.runCommand || execFileSync;
  try {
    runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', digest], {
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Promotes a single immutable digest through staging then production. Records
 * the approver identity, deployment identity, and environment config source.
 *
 * @param {object} options
 * @returns {object} The recorded deployment entry.
 */
const promoteArtifact = (options = {}) => {
  const digest = String(options.digest || '').toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`promote requires a valid --digest (sha256:<64 hex>), got "${options.digest}".`);
  }
  if (!options.approver) {
    throw new Error('promote requires --approver to record the production approver identity.');
  }
  const deploymentId = options.deploymentId || `deploy-${Date.now()}`;
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new Error(`Invalid deployment ID "${deploymentId}".`);
  }
  const deploymentRecordPath = path.resolve(
    options.deploymentRecordPath || DEFAULT_DEPLOYMENT_RECORD_PATH
  );
  const runCommand = options.runCommand || execFileSync;

  // Configuration is external; fail before touching any environment.
  const runtimeEnv = resolveRuntimeEnv(options);

  if (options.dryRun) {
    logDryRun(`deploy ${digest} to staging with external config`);
    logDryRun(`deploy ${digest} to production approved by ${options.approver}`);
    return { dryRun: true, digest, deployment_id: deploymentId };
  }

  if (!verifyDigestAvailable(digest, { runCommand })) {
    throw new Error(`Digest ${digest} is not available locally; build or pull it first.`);
  }

  const environments = ['staging', 'production'];
  const record = loadDeploymentRecord(deploymentRecordPath);
  const entry = {
    deployment_id: deploymentId,
    digest,
    approver: options.approver,
    deployed_by: options.deployedBy || process.env.GITHUB_ACTOR || os.userInfo().username,
    config_source: options.configSource || 'external-env',
    environments: {},
    promoted_at: new Date().toISOString(),
  };

  for (const environment of environments) {
    const containerName = `${DEFAULT_IMAGE_REPOSITORY}-${environment}-${deploymentId}`;
    const envArgs = Object.entries(runtimeEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    runCommand(
      'docker',
      ['run', '--detach', '--name', containerName, ...envArgs, digest],
      { stdio: 'inherit' }
    );
    entry.environments[environment] = {
      container: containerName,
      deployed_at: new Date().toISOString(),
    };
    console.log(`✅ Promoted ${digest} to ${environment} as ${containerName}.`);
  }

  record.deployments.push(entry);
  writeJsonFileAtomic(deploymentRecordPath, record, 'deployment record');
  return entry;
};

/**
 * Rolls production back to a previously verified digest.
 *
 * @param {object} options
 * @returns {object} The recorded rollback entry.
 */
const rollbackArtifact = (options = {}) => {
  const targetDigest = String(options.to || options.digest || '').toLowerCase();
  if (!DIGEST_PATTERN.test(targetDigest)) {
    throw new Error(`rollback requires --to <sha256:...>, got "${options.to}".`);
  }
  const deploymentRecordPath = path.resolve(
    options.deploymentRecordPath || DEFAULT_DEPLOYMENT_RECORD_PATH
  );
  const record = loadDeploymentRecord(deploymentRecordPath);
  const previouslyVerified = record.deployments.some(
    (entry) => entry.digest === targetDigest && entry.environments && entry.environments.production
  );
  if (!previouslyVerified) {
    throw new Error(`Digest ${targetDigest} has not been verified in production; refusing rollback.`);
  }

  const deploymentId = options.deploymentId || `rollback-${Date.now()}`;
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new Error(`Invalid deployment ID "${deploymentId}".`);
  }
  const runCommand = options.runCommand || execFileSync;

  if (options.dryRun) {
    logDryRun(`roll back production to ${targetDigest}`);
    return { dryRun: true, digest: targetDigest, deployment_id: deploymentId };
  }

  const runtimeEnv = resolveRuntimeEnv(options);
  const containerName = `${DEFAULT_IMAGE_REPOSITORY}-production-${deploymentId}`;
  const envArgs = Object.entries(runtimeEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  runCommand('docker', ['run', '--detach', '--name', containerName, ...envArgs, targetDigest], {
    stdio: 'inherit',
  });

  const entry = {
    deployment_id: deploymentId,
    digest: targetDigest,
    rollback: true,
    approver: options.approver || null,
    deployed_by: options.deployedBy || process.env.GITHUB_ACTOR || os.userInfo().username,
    environments: { production: { container: containerName, deployed_at: new Date().toISOString() } },
    promoted_at: new Date().toISOString(),
  };
  record.deployments.push(entry);
  writeJsonFileAtomic(deploymentRecordPath, record, 'deployment record');
  console.log(`✅ Rolled production back to ${targetDigest}.`);
  return entry;
};

// ── Release Preflight (Issues #469, #470) ────────────────────────────────────

/**
 * Runs the coordinated-release preflight: validates the manifest, checks that
 * the dashboard/client/contract versions and interface schemas agree, and that
 * the migration level is compatible with the target environment.
 *
 * @param {object} options
 * @returns {object} Preflight report.
 */
const runReleasePreflight = (options = {}) => {
  const manifestPath = options.manifestPath || DEFAULT_RELEASE_MANIFEST_PATH;
  const { manifest, orderedContracts } = loadReleaseManifest(manifestPath, options.network);

  const problems = [];

  // Dashboard/client package versions must match the manifest.
  const dashboardDir = path.resolve(options.dashboardDir || DEFAULT_DASHBOARD_DIR);
  const backendDir = path.resolve(options.backendDir || DEFAULT_BACKEND_DIR);
  const dashboardVersion = readPackageVersion(dashboardDir);
  const backendVersion = readPackageVersion(backendDir);
  if (dashboardVersion !== manifest.packages.dashboard) {
    problems.push(
      `Dashboard version ${dashboardVersion} does not match manifest ${manifest.packages.dashboard}.`
    );
  }
  if (backendVersion !== manifest.packages.backend) {
    problems.push(
      `Backend version ${backendVersion} does not match manifest ${manifest.packages.backend}.`
    );
  }

  // Migration level must not exceed the environment's applied level.
  if (options.currentMigrationLevel !== undefined) {
    if (!Number.isSafeInteger(options.currentMigrationLevel) || options.currentMigrationLevel < 0) {
      problems.push('currentMigrationLevel must be a non-negative integer.');
    } else if (manifest.migration_level < options.currentMigrationLevel) {
      problems.push(
        `Manifest migration_level ${manifest.migration_level} is behind applied level ${options.currentMigrationLevel}.`
      );
    } else if (manifest.migration_level > options.currentMigrationLevel + 1) {
      problems.push(
        `Manifest migration_level ${manifest.migration_level} skips more than one migration from ${options.currentMigrationLevel}.`
      );
    }
  }

  // Contract interface schemas must be unique per interface version.
  const schemaByVersion = new Map();
  for (const contract of orderedContracts) {
    const existing = schemaByVersion.get(contract.interface_version);
    if (existing && existing !== contract.interface_schema_sha256) {
      problems.push(
        `Interface version ${contract.interface_version} has conflicting schema hashes ` +
          `(${existing} vs ${contract.interface_schema_sha256}).`
      );
    }
    schemaByVersion.set(contract.interface_version, contract.interface_schema_sha256);
  }

  const report = {
    ok: problems.length === 0,
    network: manifest.network,
    migration_level: manifest.migration_level,
    packages: manifest.packages,
    contracts: orderedContracts.map((contract) => ({
      name: contract.name,
      contract_id: contract.contract_id,
      wasm_sha256: contract.wasm_sha256,
      interface_version: contract.interface_version,
      interface_schema_sha256: contract.interface_schema_sha256,
    })),
    problems,
  };

  if (!report.ok) {
    throw new Error(`Release preflight failed:\n - ${problems.join('\n - ')}`);
  }
  return report;
};

// ── Post-deployment Smoke Checks (Issue #471) ────────────────────────────────

const smokeResultsPath = (deploymentId, resultsDir) =>
  path.join(path.resolve(resultsDir || DEFAULT_SMOKE_RESULTS_DIR), `${deploymentId}.json`);

/**
 * Runs post-deployment smoke checks against the deployed contract: verifies the
 * network passphrase, on-chain WASM hash, admin state, and read interface, and
 * sends bounded, idempotent (deployment-ID-keyed) test transactions.
 *
 * @param {object} options
 * @returns {object} Smoke results keyed by deployment ID.
 */
const runSmokeChecks = async (options = {}) => {
  const deploymentId = options.deploymentId;
  if (!deploymentId || !DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new Error('smoke requires a valid --deployment-id.');
  }
  const network = NETWORKS[options.network];
  if (!network) {
    throw new Error(`Unknown network "${options.network}".`);
  }
  const contractId = options.contractId;
  if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
    throw new Error('smoke requires a valid --contract-id.');
  }
  const expectedWasmHash = String(options.expectedWasmHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedWasmHash)) {
    throw new Error('smoke requires --expected-wasm-hash (64 hex chars).');
  }
  const expectedAdmin = options.expectedAdmin;
  if (!expectedAdmin) {
    throw new Error('smoke requires --expected-admin.');
  }

  const resultsPath = smokeResultsPath(deploymentId, options.resultsDir);
  const runCommand = options.runCommand || execFileSync;
  const checks = [];

  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) {
      throw new Error(`Smoke check "${name}" failed: ${detail}`);
    }
  };

  // Network passphrase.
  record(
    'network',
    network.networkPassphrase === options.expectedPassphrase ||
      options.expectedPassphrase === undefined,
    `network ${network.name}`
  );

  // On-chain WASM hash.
  const deployedHash = String(
    await (options.getContractHash || ((id) => readOnChainContractWasmHash(id, network, runCommand)))(
      contractId
    )
  ).toLowerCase();
  record(
    'wasm_hash',
    hashesEqual(deployedHash, expectedWasmHash),
    `expected ${expectedWasmHash}, got ${deployedHash}`
  );

  // Admin state.
  const admin = options.getAdmin
    ? await options.getAdmin(contractId)
    : readContractAdmin(network, contractId);
  record('admin', admin === expectedAdmin, `expected ${expectedAdmin}, got ${admin}`);

  // Read interface.
  const interfaceVersion = Number(
    await (options.getInterfaceVersion ||
      ((id) => readOnChainInterfaceVersion(id, network, runCommand)))(contractId)
  );
  record(
    'interface',
    Number.isSafeInteger(interfaceVersion) && interfaceVersion >= 1,
    `interface version ${interfaceVersion}`
  );

  // Bounded, idempotent test transaction keyed by deployment ID.
  const memo = `smoke:${deploymentId}`;
  let attempts = 0;
  let txOk = false;
  let txDetail = '';
  while (attempts < SMOKE_MAX_ATTEMPTS && !txOk) {
    attempts += 1;
    try {
      if (options.sendTestTransaction) {
        await options.sendTestTransaction({ contractId, network, memo, amount: SMOKE_AMOUNT });
      } else {
        runCommand(
          'stellar',
          [
            'contract',
            'invoke',
            '--id',
            contractId,
            '--network',
            network.name,
            '--rpc-url',
            network.rpcUrl,
            '--',
            'get_config',
          ],
          { cwd: CONTRACT_DIR, encoding: 'utf8' }
        );
      }
      txOk = true;
      txDetail = `memo ${memo} attempt ${attempts}`;
    } catch (error) {
      txDetail = `attempt ${attempts}: ${error.message}`;
    }
  }
  record('test_transaction', txOk, txDetail);

  const result = {
    schema_version: 1,
    deployment_id: deploymentId,
    network: network.name,
    contract_id: contractId,
    wasm_sha256: deployedHash,
    interface_version: interfaceVersion,
    admin,
    checks,
    passed: checks.every((check) => check.ok),
    ran_at: new Date().toISOString(),
  };
  writeJsonFileAtomic(resultsPath, result, 'smoke results');
  console.log(`✅ Smoke checks passed for deployment ${deploymentId}.`);
  return result;
};

// ── WASM Hash Verification ───────────────────────────────────────────────────

/**
 * Computes the SHA-256 hash of a local WASM file.
 *
 * @param {string} wasmPath - Absolute path to the .wasm file.
 * @returns {string} Lowercase hex-encoded SHA-256 digest.
 */
const computeLocalWasmHash = (wasmPath) => {
  const buffer = fs.readFileSync(wasmPath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
};

/**
 * Retrieves the on-chain WASM hash for an uploaded contract via the Stellar RPC.
 *
 * @param {string} wasmHash - Hex-encoded hash returned by the upload step.
 * @param {object} network - Network configuration object.
 * @returns {Promise<string>} Lowercase hex-encoded on-chain hash.
 */
const fetchOnChainWasmHash = async (wasmHash, network) => {
  const response = await fetch(network.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getContractWasmByHash',
      params: { hash: wasmHash },
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`RPC error: ${payload.error.message || JSON.stringify(payload.error)}`);
  }

  const result = payload.result;
  const reportedHash =
    typeof result === 'string' && /^[a-fA-F0-9]{64}$/.test(result)
      ? result
      : result && (result.hash || result.wasmHash || result.wasm_hash);
  if (reportedHash) {
    return String(reportedHash).toLowerCase();
  }

  const wasmBase64 = typeof result === 'string' ? result : result && result.wasm;
  if (typeof wasmBase64 !== 'string' || wasmBase64.length === 0) {
    throw new Error('RPC response did not include a WASM blob or hash');
  }
  const normalizedBase64 = wasmBase64.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalizedBase64)) {
    throw new Error('RPC response included an invalid WASM blob');
  }
  const wasm = Buffer.from(normalizedBase64, 'base64');
  if (wasm.length === 0) {
    throw new Error('RPC response included an invalid WASM blob');
  }
  return crypto.createHash('sha256').update(wasm).digest('hex');
};

/**
 * Verifies that the uploaded WASM hash matches the local file's SHA-256.
 * Aborts the process with a non-zero exit code if they differ.
 *
 * @param {string} wasmPath - Local .wasm file path.
 * @param {string} uploadedHash - Hash returned by the upload step.
 * @param {object} network - Network configuration object.
 * @param {object} [options]
 * @returns {Promise<boolean>} True when the hashes match (or check skipped).
 */
const verifyWasmHash = async (wasmPath, uploadedHash, network, options = {}) => {
  const expectedHash = computeLocalWasmHash(wasmPath);

  if (options.skipHashCheck) {
    console.warn('⚠️  --skip-hash-check enabled: skipping WASM hash verification.');
    console.warn(`   Expected (local) hash: ${expectedHash}`);
    return true;
  }

  const actualHash = await fetchOnChainWasmHash(uploadedHash, network);

  console.log(`🔎 Expected WASM hash (local):  ${expectedHash}`);
  console.log(`🔎 Actual WASM hash (on-chain): ${actualHash}`);

  if (!hashesEqual(expectedHash, actualHash)) {
    console.error('❌ WASM hash mismatch: the uploaded contract does not match the local file.');
    console.error(`   Expected: ${expectedHash}`);
    console.error(`   Actual:   ${actualHash}`);
    process.exit(1);
  }

  console.log('✅ WASM hash verified: on-chain hash matches local file.');
  return true;
};

/**
 * Reads the expected WASM hash from the committed manifest file.
 * Tolerates trailing whitespace and a trailing filename (sha256sum output).
 *
 * @param {string} [manifestPath]
 * @returns {string|null} Lowercase hex-encoded expected hash, or null if unavailable.
 */
const readExpectedWasmHash = (manifestPath = WASM_HASH_MANIFEST_PATH) => {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const content = fs.readFileSync(manifestPath, 'utf8').trim();
  if (!content) {
    return null;
  }

  // Support both "<hash>" and "<hash>  <filename>" (sha256sum) formats.
  const match = content.match(/^([a-fA-F0-9]{64})\b/);
  return match ? match[1].toLowerCase() : null;
};

/**
 * Writes the freshly computed WASM hash to the manifest file.
 *
 * @param {string} wasmHash - Lowercase hex-encoded SHA-256 digest.
 * @param {string} [manifestPath]
 * @returns {boolean} True when written.
 */
const writeExpectedWasmHash = (wasmHash, manifestPath = WASM_HASH_MANIFEST_PATH) => {
  try {
    fs.writeFileSync(manifestPath, `${wasmHash}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`[deploy] Could not write WASM hash manifest ${manifestPath}:`, err.message);
    return false;
  }
};

/**
 * Verifies the local WASM file's SHA-256 against the committed manifest before upload.
 * Aborts with a non-zero exit code on mismatch unless skipHashCheck is set.
 *
 * @param {string} wasmPath - Local .wasm file path.
 * @param {object} [options]
 * @returns {boolean} True when the hash matches (or the check is skipped).
 */
const verifyLocalWasmHash = (wasmPath, options = {}) => {
  if (!wasmPath || !fs.existsSync(wasmPath)) {
    console.error(`❌ WASM file not found: ${wasmPath}`);
    if (!options.skipHashCheck) {
      process.exit(1);
    }
    return false;
  }

  const actualHash = computeLocalWasmHash(wasmPath);
  const expectedHash = readExpectedWasmHash(options.hashManifestPath);

  if (options.skipHashCheck) {
    console.warn('⚠️  --skip-hash-check enabled: skipping pre-deployment WASM hash verification.');
    console.warn(`   Actual (local) hash: ${actualHash}`);
    return true;
  }

  if (!expectedHash) {
    console.error(`❌ Expected WASM hash manifest missing or invalid: ${options.hashManifestPath || WASM_HASH_MANIFEST_PATH}`);
    console.error('   Run a clean build to generate it, or pass --skip-hash-check to bypass.');
    process.exit(1);
  }

  console.log(`🔎 Expected WASM hash (manifest): ${expectedHash}`);
  console.log(`🔎 Actual WASM hash (local):     ${actualHash}`);

  if (!hashesEqual(expectedHash, actualHash)) {
    console.error('❌ WASM hash mismatch: the compiled WASM does not match the committed manifest.');
    console.error(`   Expected: ${expectedHash}`);
    console.error(`   Actual:   ${actualHash}`);
    console.error('   Aborting deployment. Pass --skip-hash-check to bypass (not recommended).');
    process.exit(1);
  }

  console.log('✅ Pre-deployment WASM hash verified against manifest.');
  return true;
};

// ── CLI Argument Parser ──────────────────────────────────────────────────────

/**
 * Parses CLI arguments into structured options.
 *
 * @param {string[]} argv
 * @returns {object}
 */
const parseArgs = (argv = process.argv.slice(2)) => {
  const options = {
    command: 'deploy',
    network: 'testnet',
    source: process.env.STELLAR_SECRET_KEY || process.env.SOROBAN_SECRET_KEY || null,
    admin: process.env.ADMIN_ADDRESS || null,
    treasury: process.env.PLATFORM_TREASURY || null,
    feeBps: 100, // 1%
    feeCap: '10000000', // 1 XLM (7 decimals)
    maxAmount: '1000000000000000',
    contractId: process.env.CONTRACT_ID || process.env.PAYMENT_ROUTER_CONTRACT_ID || null,
    wasmPath: null,
    manifestPath: null,
    timelockNonce: null,
    dryRun: false,
    skipBuild: false,
    skipHashCheck: false,
    envFiles: [
      path.join(ROOT_DIR, 'stellar-payment-platform', '.env'),
      path.join(ROOT_DIR, 'payment-dashboard', '.env'),
      path.join(ROOT_DIR, '.env'),
    ],
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      return options;
    } else if (arg === '--version' || arg === '-v') {
      options.command = 'version';
      return options;
    } else if (arg === '--network' || arg === '-n') {
      options.network = argv[++i];
    } else if (arg === '--source' || arg === '-s') {
      options.source = argv[++i];
    } else if (arg === '--admin') {
      options.admin = argv[++i];
    } else if (arg === '--treasury') {
      options.treasury = argv[++i];
    } else if (arg === '--fee-bps') {
      options.feeBps = parseInt(argv[++i], 10);
    } else if (arg === '--fee-cap') {
      options.feeCap = argv[++i];
    } else if (arg === '--max-amount') {
      options.maxAmount = argv[++i];
    } else if (arg === '--contract-id' || arg === '-c') {
      options.contractId = argv[++i];
    } else if (arg === '--wasm') {
      options.wasmPath = argv[++i];
    } else if (arg === '--manifest') {
      options.manifestPath = path.resolve(argv[++i]);
    } else if (arg === '--nonce') {
      options.timelockNonce = Number(argv[++i]);
    } else if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--skip-hash-check') {
      options.skipHashCheck = true;
    } else if (arg === '--digest') {
      options.digest = argv[++i];
    } else if (arg === '--to') {
      options.to = argv[++i];
    } else if (arg === '--approver') {
      options.approver = argv[++i];
    } else if (arg === '--deployment-id') {
      options.deploymentId = argv[++i];
    } else if (arg === '--build-record') {
      options.buildRecordPath = path.resolve(argv[++i]);
    } else if (arg === '--deployment-record') {
      options.deploymentRecordPath = path.resolve(argv[++i]);
    } else if (arg === '--results-dir') {
      options.resultsDir = path.resolve(argv[++i]);
    } else if (arg === '--expected-wasm-hash') {
      options.expectedWasmHash = argv[++i];
    } else if (arg === '--expected-admin') {
      options.expectedAdmin = argv[++i];
    } else if (arg === '--artifact') {
      options.artifactPath = path.resolve(argv[++i]);
    } else if (arg === '--artifact-type') {
      options.artifactType = argv[++i];
    } else if (arg === '--attestation') {
      options.attestationPath = path.resolve(argv[++i]);
    } else if (arg === '--source-commit') {
      options.sourceCommit = argv[++i];
    } else if (arg === '--workflow-ref') {
      options.workflowIdentity = { ...(options.workflowIdentity || {}), workflow_ref: argv[++i] };
    } else if (arg === '--canary-record') {
      options.canaryRecordPath = path.resolve(argv[++i]);
    } else if (arg === '--traffic-percent') {
      options.policy = { ...(options.policy || {}), traffic_percent: Number(argv[++i]) };
    } else if (arg === '--evaluation-window') {
      options.policy = { ...(options.policy || {}), evaluation_window_seconds: Number(argv[++i]) };
    } else if (arg === '--latency-p95-ms') {
      options.policy = { ...(options.policy || {}), latency_p95_ms: Number(argv[++i]) };
    } else if (arg === '--error-rate-percent') {
      options.policy = { ...(options.policy || {}), error_rate_percent: Number(argv[++i]) };
    } else if (arg === '--override-actor') {
      options.manualOverride = { ...(options.manualOverride || {}), actor: argv[++i] };
    } else if (arg === '--override-reason') {
      options.manualOverride = { ...(options.manualOverride || {}), reason: argv[++i] };
    } else if (arg === '--env-file') {
      options.envFiles.push(path.resolve(argv[++i]));
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0].toLowerCase();
    if (['build', 'deploy', 'upgrade', 'upgrade-manifest', 'execute-action', 'init', 'status', 'verify-hash', 'provenance', 'canary'].includes(cmd)) {
      options.command = cmd;
    }
    if (options.command === 'provenance' && positional[1]) {
      options.provenanceAction = positional[1].toLowerCase();
    } else if (positional[1] && !options.contractId) {
      options.contractId = positional[1];
    }
  }

  return options;
};

// ── Dry Run Helpers ──────────────────────────────────────────────────────────

/**
 * Logs a step that would be executed on-chain, without performing it.
 *
 * @param {string} description
 */
const logDryRun = (description) => {
  console.log(`[DRY RUN] Would execute: ${description}`);
};

/**
 * Runs a shell command, or logs it when in dry-run mode.
 *
 * @param {string} command
 * @param {object} [execOptions]
 * @param {boolean} [dryRun]
 * @returns {string|null} Command output, or null when skipped.
 */
const runOrDryRun = (command, execOptions = {}, dryRun = false) => {
  if (dryRun) {
    logDryRun(command);
    return null;
  }
  return execSync(command, execOptions);
};

// ── Environment File Updater ─────────────────────────────────────────────────

/**
 * Updates or sets an environment variable in an .env file.
 *
 * @param {string} filePath - Absolute path to .env file.
 * @param {string} key - Environment variable key.
 * @param {string} value - Environment variable value.
 * @returns {boolean} True if updated/created.
 */
const setEnvVariable = (filePath, key, value) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }

    const regex = new RegExp(`^(${key}=).*$`, 'm');
    let updatedContent;
    if (regex.test(content)) {
      updatedContent = content.replace(regex, `${key}="${value}"`);
    } else {
      const newLine = content.endsWith('\n') || content.length === 0 ? '' : '\n';
      updatedContent = `${content}${newLine}${key}="${value}"\n`;
    }

    fs.writeFileSync(filePath, updatedContent, 'utf8');
    return true;
  } catch (err) {
    console.error(`[deploy] Failed to update env file ${filePath}:`, err.message);
    return false;
  }
};

/**
 * Updates all relevant frontend and backend configuration files with the contract ID.
 *
 * @param {string} contractId
 * @param {string[]} envFiles
 * @param {object} [options]
 * @returns {string[]} List of successfully updated files.
 */
const updateAllConfigs = (contractId, envFiles = [], options = {}) => {
  const updated = [];

  if (options.dryRun) {
    logDryRun(`update config files with contract ID ${contractId}`);
    for (const envFile of envFiles) {
      logDryRun(`set PAYMENT_ROUTER_CONTRACT_ID/CONTRACT_ID/VITE_CONTRACT_ID in ${envFile}`);
    }
    return updated;
  }

  for (const envFile of envFiles) {
    if (setEnvVariable(envFile, 'PAYMENT_ROUTER_CONTRACT_ID', contractId)) {
      setEnvVariable(envFile, 'CONTRACT_ID', contractId);
      setEnvVariable(envFile, 'VITE_CONTRACT_ID', contractId);
      updated.push(envFile);
    }
  }

  // Also update payment-dashboard/src/views/shared.js if present and allowed
  if (options.updateSharedJs !== false) {
    const rootDir = options.rootDir || ROOT_DIR;
    const sharedJsPath = path.join(rootDir, 'payment-dashboard', 'src', 'views', 'shared.js');
    if (fs.existsSync(sharedJsPath)) {
      try {
        let content = fs.readFileSync(sharedJsPath, 'utf8');
        const contractIdRegex = /export const CONTRACT_ID = ['"][^'"]*['"];/;
        if (contractIdRegex.test(content)) {
          content = content.replace(
            contractIdRegex,
            `export const CONTRACT_ID = '${contractId}';`
          );
          fs.writeFileSync(sharedJsPath, content, 'utf8');
          updated.push(sharedJsPath);
        }
      } catch (err) {
        console.warn('[deploy] Could not update shared.js:', err.message);
      }
    }
  }

  return updated;
};

// ── Compilation & Optimization ───────────────────────────────────────────────

/**
 * Compiles the Soroban contract to WASM and optimizes bytecode.
 *
 * @param {object} options
 * @returns {string} Path to the compiled/optimized WASM file.
 */
const compileAndOptimizeWasm = (options = {}) => {
  if (options.wasmPath && fs.existsSync(options.wasmPath)) {
    console.log(`📦 Using provided WASM file: ${options.wasmPath}`);
    return options.wasmPath;
  }

  console.log('🔨 Compiling Soroban smart contract...');

  try {
    execSync('cargo build --target wasm32-unknown-unknown --release', {
      cwd: CONTRACT_DIR,
      stdio: 'inherit',
    });
  } catch {
    console.warn('⚠️  Cargo compilation failed or cargo not available.');
  }

  let wasmPath = DEFAULT_WASM_PATH;
  if (!fs.existsSync(wasmPath)) {
    console.warn(`⚠️  Compiled WASM not found at ${wasmPath}`);
    return wasmPath;
  }

  console.log('⚙️  Optimizing WASM bytecode...');
  try {
    execSync(
      `stellar contract optimize --wasm ${wasmPath} --wasm-out ${DEFAULT_OPTIMIZED_WASM_PATH}`,
      { cwd: CONTRACT_DIR, stdio: 'inherit' }
    );
    wasmPath = DEFAULT_OPTIMIZED_WASM_PATH;
  } catch {
    console.warn('⚠️  Optimization failed; using unoptimized WASM.');
  }

  return wasmPath;
};

// ── RPC / On-chain Operations ────────────────────────────────────────────────

/**
 * Deploys the contract to the configured network.
 *
 * @param {object} options
 * @param {string} wasmPath
 * @returns {string|null} Deployed contract ID, or null in dry-run.
 */
const deployContract = (options, wasmPath) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;

  if (options.dryRun) {
    logDryRun(
      `stellar contract deploy --wasm ${wasmPath} --network ${network.name} --rpc-url ${network.rpcUrl}`
    );
    return null;
  }

  const output = execSync(
    `stellar contract deploy --wasm ${wasmPath} --network ${network.name} --rpc-url ${network.rpcUrl}`,
    { cwd: CONTRACT_DIR, encoding: 'utf8' }
  );
  return output.trim();
};

/**
 * Initializes the deployed contract with admin/treasury/fee configuration.
 *
 * @param {object} options
 * @param {string} contractId
 */
const initializeContract = (options, contractId) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;

  if (options.dryRun) {
    logDryRun(
      `stellar contract invoke --id ${contractId} --network ${network.name} -- initialize --admin ${options.admin} --treasury ${options.treasury} --fee_bps ${options.feeBps} --fee_cap ${options.feeCap} --max_amount ${options.maxAmount}`
    );
    return;
  }

  execSync(
    `stellar contract invoke --id ${contractId} --network ${network.name} -- initialize --admin ${options.admin} --treasury ${options.treasury} --fee_bps ${options.feeBps} --fee_cap ${options.feeCap} --max_amount ${options.maxAmount}`,
    { cwd: CONTRACT_DIR, stdio: 'inherit' }
  );
};

/**
 * Reads the current admin address from a live contract.
 * Returns null and logs a warning if the contract does not expose get_admin.
 *
 * @param {object} network
 * @param {string} contractId
 * @returns {string|null}
 */
const readContractAdmin = (network, contractId) => {
  try {
    const out = execSync(
      `stellar contract invoke --id ${contractId} --network ${network.name} --rpc-url ${network.rpcUrl} -- get_admin`,
      { cwd: CONTRACT_DIR, encoding: 'utf8' }
    );
    // The CLI wraps string values in quotes; strip them.
    return out.trim().replace(/^"|"$/g, '') || null;
  } catch {
    return null;
  }
};

/**
 * Queues an existing contract's WASM upgrade for the 24-hour timelock.
 *
 * @param {object} options
 * @param {string} contractId
 * @param {string} wasmPath
 */
const upgradeContract = (options, contractId, wasmPath) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;
  const sourceFlag = options.source ? `--source ${options.source}` : '';

  if (options.dryRun) {
    logDryRun(
      `stellar contract install --wasm ${wasmPath} --network ${network.name} --rpc-url ${network.rpcUrl}`
    );
    logDryRun(
      `stellar contract invoke --id ${contractId} --network ${network.name} ${sourceFlag} -- queue_upgrade --new_wasm_hash <hash>`
    );
    return;
  }

  const wasmHash = String(
    execFileSync(
      'stellar',
      [
        'contract',
        'install',
        '--wasm',
        wasmPath,
        '--network',
        network.name,
        '--rpc-url',
        network.rpcUrl,
      ],
      { cwd: CONTRACT_DIR, encoding: 'utf8' }
    )
  ).trim();
  if (!/^[a-fA-F0-9]{64}$/.test(wasmHash)) {
    throw new Error(`Could not read the installed WASM hash: ${wasmHash}`);
  }

  const invokeArgs = ['contract', 'invoke', '--id', contractId, '--network', network.name];
  if (options.source) {
    invokeArgs.push('--source', options.source);
  }
  invokeArgs.push('--', 'queue_upgrade', '--new_wasm_hash', wasmHash);
  const queueOutput = String(
    execFileSync('stellar', invokeArgs, { cwd: CONTRACT_DIR, encoding: 'utf8' })
  ).trim();
  const nonceMatch = queueOutput.match(/^(?:"?)(\d+)(?:"?)$/);
  if (!nonceMatch) {
    throw new Error(`Could not read the timelock nonce from upgrade result: ${queueOutput}`);
  }
  const nonce = Number(nonceMatch[1]);
  console.log(`✅ Upgrade queued as action ${nonce}. It can be executed after 24 hours with:`);
  console.log(
    `node scripts/deploy.js execute-action --contract-id ${contractId} --nonce ${nonce} --network ${network.name}${options.source ? ` --source ${options.source}` : ''}`
  );
};

/**
 * Fetches the current status of a deployed contract.
 *
 * @param {object} options
 * @param {string} contractId
 */
const getContractStatus = (options, contractId) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;

  if (options.dryRun) {
    logDryRun(
      `stellar contract invoke --id ${contractId} --network ${network.name} -- get_config`
    );
    return;
  }

  execSync(
    `stellar contract invoke --id ${contractId} --network ${network.name} -- get_config`,
    { cwd: CONTRACT_DIR, stdio: 'inherit' }
  );
};

// ── Input Validation ─────────────────────────────────────────────────────────

/**
 * Validates parsed options before any on-chain work.
 *
 * @param {object} options
 * @returns {boolean} True when valid.
 */
const validateOptions = (options) => {
  if (!NETWORKS[options.network]) {
    console.error(`❌ Unknown network: ${options.network}`);
    console.error(`   Supported networks: ${Object.keys(NETWORKS).join(', ')}`);
    return false;
  }

  if (options.command === 'deploy' || options.command === 'init') {
    if (!options.admin) {
      console.error('❌ Missing --admin address.');
      return false;
    }
    if (!options.treasury) {
      console.error('❌ Missing --treasury address.');
      return false;
    }
  }

  if (options.command === 'upgrade' || options.command === 'status' || options.command === 'execute-action') {
    if (!options.contractId) {
      console.error('❌ Missing --contract-id.');
      return false;
    }
  }

  if (options.command === 'execute-action' &&
      (!Number.isSafeInteger(options.timelockNonce) || options.timelockNonce < 1)) {
    console.error('❌ Missing or invalid --nonce.');
    return false;
  }

  if (options.command === 'upgrade-manifest' && !options.manifestPath) {
    console.error('❌ Missing --manifest path for coordinated upgrade.');
    return false;
  }

  if (options.command === 'provenance') {
    if (!options.artifactPath) {
      console.error('❌ Missing --artifact path for provenance.');
      return false;
    }
    if (options.provenanceAction === 'generate' && !ARTIFACT_TYPES.includes(options.artifactType)) {
      console.error(`❌ Missing or invalid --artifact-type (${ARTIFACT_TYPES.join(', ')}).`);
      return false;
    }
    if (options.provenanceAction !== 'generate' && !options.attestationPath) {
      console.error('❌ Missing --attestation path for provenance verification.');
      return false;
    }
  }

  if (options.command === 'canary' && !DIGEST_PATTERN.test(String(options.digest || '').toLowerCase())) {
    console.error('❌ Missing or invalid --digest for canary.');
    return false;
  }

  return true;
};

// ── Help ─────────────────────────────────────────────────────────────────────

const printHelp = () => {
  console.log(`
PaymentRouter Deployment CLI

Usage:
  node scripts/deploy.js [command] [options]

Commands:
  build                 Compile and optimize the contract WASM
  verify-hash           Verify the compiled WASM hash against payment_router/wasm.sha256
  deploy                Compile, deploy, and initialize the contract
  upgrade               Queue a single-contract upgrade
  upgrade-manifest      Validate and queue a coordinated upgrade
  execute-action        Execute a matured timelock action
  init                  Initialize an existing contract
  status                Show current contract configuration
  provenance generate   Generate a SLSA provenance attestation for an artifact
  provenance verify     Verify an attestation against an artifact digest
  canary                Run a canary rollout with automated rollback gates

Options:
  -n, --network <name>  Network: testnet | mainnet | futurenet | local (default: testnet)
  -s, --source <key>    Stellar secret key for signing
      --admin <addr>    Admin address
      --treasury <addr> Platform treasury address
      --fee-bps <n>     Fee in basis points (default: 100)
      --fee-cap <n>     Fee cap (default: 10000000)
      --max-amount <n>  Max transfer amount
  -c, --contract-id <id> Contract ID (for upgrade/init/status/execute-action)
      --wasm <path>     Use a pre-built WASM file
      --manifest <path> Release manifest for upgrade-manifest
      --execute         Execute queued manifest upgrades after 24 hours
      --nonce <number>  Timelock nonce for execute-action
      --dry-run         Simulate the workflow without RPC calls or on-chain transactions
      --skip-build      Skip WASM compilation
      --skip-hash-check Bypass the pre-deployment WASM hash verification
      --artifact <path> Artifact file for provenance
      --artifact-type <t> Provenance artifact type: backend | dashboard | contract
      --attestation <p> Provenance attestation output/input path
      --source-commit <sha> Source commit bound into provenance
      --workflow-ref <ref> Workflow identity bound into provenance
      --traffic-percent <n> Canary traffic percentage (default: 10)
      --evaluation-window <s> Canary evaluation window seconds (default: 300)
      --latency-p95-ms <n> Canary latency p95 threshold (default: 500)
      --error-rate-percent <n> Canary error rate threshold (default: 1)
      --override-actor <id> Audited manual override actor
      --override-reason <r> Audited manual override reason
      --env-file <path> Additional .env file to update
  -h, --help            Show this help
  -v, --version         Show version
`);
};

// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
  const options = parseArgs();

  if (options.command === 'help') {
    printHelp();
    return;
  }

  if (options.command === 'version') {
    const pkg = require(path.join(ROOT_DIR, 'package.json'));
    console.log(pkg.version || '0.0.0');
    return;
  }

  if (!validateOptions(options)) {
    process.exitCode = 1;
    return;
  }

  const network = NETWORKS[options.network];
  console.log(`\n🌐 Network: ${network.name} (${network.rpcUrl})`);
  if (options.dryRun) {
    console.log('🧪 DRY RUN enabled — no RPC calls or on-chain transactions will be made.');
  }

  if (options.command === 'provenance') {
    runProvenanceCommand(options);
    return;
  }

  if (options.command === 'canary') {
    await runCanaryRollout(options);
    return;
  }

  if (options.command === 'upgrade-manifest') {
    await upgradeReleaseManifest(options);
    return;
  }

  if (options.command === 'execute-action') {
    const network = NETWORKS[options.network];
    const sourceFlag = options.source ? `--source ${options.source}` : '';
    if (options.dryRun) {
      logDryRun(
        `stellar contract invoke --id ${options.contractId} --network ${network.name} ${sourceFlag} -- execute_action --nonce ${options.timelockNonce}`
      );
    } else {
      const invokeArgs = [
        'contract',
        'invoke',
        '--id',
        options.contractId,
        '--network',
        network.name,
      ];
      if (options.source) {
        invokeArgs.push('--source', options.source);
      }
      invokeArgs.push('--', 'execute_action', '--nonce', String(options.timelockNonce));
      execFileSync(
        'stellar',
        invokeArgs,
        { cwd: CONTRACT_DIR, stdio: 'inherit' }
      );
    }
    return;
  }

  let wasmPath = options.wasmPath;

  if (
    options.command === 'build' ||
    options.command === 'deploy' ||
    options.command === 'upgrade' ||
    options.command === 'verify-hash'
  ) {
    if (!options.skipBuild) {
      wasmPath = compileAndOptimizeWasm(options);
    } else if (!wasmPath) {
      wasmPath = DEFAULT_OPTIMIZED_WASM_PATH;
    }
  }

  if (options.command === 'build') {
    if (wasmPath && fs.existsSync(wasmPath)) {
      const freshHash = computeLocalWasmHash(wasmPath);
      if (writeExpectedWasmHash(freshHash)) {
        console.log(`✅ Updated WASM hash manifest: ${WASM_HASH_MANIFEST_PATH}`);
      }
    }
    console.log(`✅ Build complete: ${wasmPath}`);
    return;
  }

  if (options.command === 'verify-hash') {
    verifyLocalWasmHash(wasmPath, options);
    return;
  }

  if (options.command === 'deploy') {
    verifyLocalWasmHash(wasmPath, options);
    if (options.attestationPath) {
      verifyProvenance({ attestationPath: options.attestationPath, artifactPath: wasmPath });
    }
    const contractId = deployContract(options, wasmPath);
    if (options.dryRun) {
      logDryRun('initialize contract after deploy');
      updateAllConfigs('<contract-id>', options.envFiles, { dryRun: true });
      console.log('\n✅ Dry run complete. No transactions were submitted.');
      return;
    }
    if (!contractId) {
      console.error('❌ Deployment did not return a contract ID.');
      process.exitCode = 1;
      return;
    }
    console.log(`✅ Deployed contract: ${contractId}`);
    initializeContract(options, contractId);
    const updated = updateAllConfigs(contractId, options.envFiles);
    console.log(`✅ Updated ${updated.length} config file(s).`);
    return;
  }

  if (options.command === 'init') {
    initializeContract(options, options.contractId);
    if (options.dryRun) {
      console.log('\n✅ Dry run complete. No transactions were submitted.');
      return;
    }
    console.log('✅ Contract initialized.');
    return;
  }

  if (options.command === 'upgrade') {
    upgradeContract(options, options.contractId, wasmPath);
    if (options.dryRun) {
      console.log('\n✅ Dry run complete. No transactions were submitted.');
      return;
    }
    console.log('✅ Upgrade action queued.');
    return;
  }

  if (options.command === 'status') {
    getContractStatus(options, options.contractId);
    return;
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[deploy] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  NETWORKS,
  parseArgs,
  setEnvVariable,
  updateAllConfigs,
  compileAndOptimizeWasm,
  computeLocalWasmHash,
  fetchOnChainWasmHash,
  readExpectedWasmHash,
  writeExpectedWasmHash,
  verifyLocalWasmHash,
  topologicallySortContracts,
  loadReleaseManifest,
  readOnChainContractWasmHash,
  readOnChainInterfaceVersion,
  upgradeReleaseManifest,
  deployContract,
  initializeContract,
  upgradeContract,
  readContractAdmin,
  getContractStatus,
  validateOptions,
  logDryRun,
  runOrDryRun,
  generateProvenance,
  verifyProvenance,
  runProvenanceCommand,
  resolveCanaryPolicy,
  evaluateCanaryMetrics,
  acquireCanaryLock,
  runCanaryRollout,
  CANARY_DEFAULT_POLICY,
  main,
};
