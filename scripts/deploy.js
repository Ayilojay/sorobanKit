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
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absoluteManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read release manifest ${absoluteManifestPath}: ${error.message}`);
  }

  if (!manifest || manifest.schema_version !== 1) {
    throw new Error('Release manifest must have schema_version 1.');
  }
  if (!NETWORKS[manifest.network]) {
    throw new Error(`Release manifest has unsupported network "${manifest.network}".`);
  }
  if (selectedNetwork && manifest.network !== selectedNetwork) {
    throw new Error(
      `Release manifest network "${manifest.network}" does not match selected network "${selectedNetwork}".`
    );
  }
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    throw new Error('Release manifest must contain at least one contract.');
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
    if (!Number.isSafeInteger(entry.interface_version) || entry.interface_version < 1) {
      throw new Error(`Contract "${entry.name}" must have a positive integer interface_version.`);
    }
    if (!Array.isArray(entry.dependencies) ||
        entry.dependencies.some((dependency) => typeof dependency !== 'string') ||
        new Set(entry.dependencies).size !== entry.dependencies.length) {
      throw new Error(`Contract "${entry.name}" must have a unique dependencies array.`);
    }

    const wasmPath = path.resolve(path.dirname(absoluteManifestPath), entry.wasm_path);
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file for contract "${entry.name}" does not exist: ${wasmPath}`);
    }
    const actualHash = computeLocalWasmHash(wasmPath);
    if (!hashesEqual(actualHash, entry.wasm_sha256)) {
      throw new Error(
        `WASM hash mismatch for "${entry.name}": manifest=${entry.wasm_sha256.toLowerCase()} local=${actualHash}.`
      );
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
      resolved_wasm_path: wasmPath,
      wasm_sha256: entry.wasm_sha256.toLowerCase(),
    };
  });

  return {
    manifest: { ...manifest, contracts },
    manifestPath: absoluteManifestPath,
    orderedContracts: topologicallySortContracts(contracts),
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
    } else if (arg === '--env-file') {
      options.envFiles.push(path.resolve(argv[++i]));
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0].toLowerCase();
    if (['build', 'deploy', 'upgrade', 'upgrade-manifest', 'execute-action', 'init', 'status', 'verify-hash'].includes(cmd)) {
      options.command = cmd;
    }
    if (positional[1] && !options.contractId) {
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
  main,
};
