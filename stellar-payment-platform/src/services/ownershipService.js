'use strict';

/**
 * Proves that a caller controls the Stellar account behind a username.
 *
 * The caller signs `${operation}:${username}` with the account key.  Three
 * verification paths are accepted:
 *
 * 1. **Freighter / single-signer** – a base64-encoded Ed25519 signature
 *    created by the account's master key.
 *
 * 2. **Multi-sig single address** – `signature` is a single valid Ed25519
 *    public key belonging to one of the account's co-signers.  The
 *    `verifyMultiSignerThreshold` helper is called with that one key.
 *
 * 3. **Multi-sig array** – `signature` is an array of valid Ed25519 public
 *    keys, one per co-signer.  All keys are forwarded to
 *    `verifyMultiSignerThreshold` so the threshold can be met by combining
 *    the weights of multiple signers (e.g. 2-of-3).
 *
 * Paths 2 and 3 are detected by checking the runtime type of `signature`
 * before attempting Freighter-style Ed25519 verification.
 */

const crypto = require('crypto');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../prismaClient');
const { poolGet } = require('../db');
const { verifyMultiSignerThreshold, fetchAccountSigners } = require('../multisigner-verifier');
const { normalizeNameTag, shouldFallbackToLocalRegistry } = require('../utils');

const DEFAULT_SIGNER_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const SIGNER_CACHE_TTL_MS =
  Number(process.env.SIGNER_CACHE_TTL_MS) > 0
    ? Number(process.env.SIGNER_CACHE_TTL_MS)
    : DEFAULT_SIGNER_CACHE_TTL_MS;
const SIGNER_CACHE_KEY_PREFIX = 'signers:';

// In-memory TTL cache: key -> { value, expiresAt }
const _signerMemoryCache = new Map();
let _signerRedisClient = null;

const getEffectiveSignerCacheTtlMs = (overrideTtlMs) => {
  if (typeof overrideTtlMs === 'number' && overrideTtlMs > 0) {
    return overrideTtlMs;
  }
  const envTtl = Number(process.env.SIGNER_CACHE_TTL_MS);
  return Number.isFinite(envTtl) && envTtl > 0 ? envTtl : SIGNER_CACHE_TTL_MS;
};

const setSignerRedisClient = (redisClient) => {
  _signerRedisClient = redisClient || null;
};

const clearSignerCache = () => {
  _signerMemoryCache.clear();
};

const readMemoryCache = (key) => {
  const entry = _signerMemoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    _signerMemoryCache.delete(key);
    return undefined;
  }
  return entry.value;
};

const writeMemoryCache = (key, value, ttlMs) => {
  _signerMemoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const readRedisCache = async (redisClient, key, ttlMs) => {
  if (!redisClient || redisClient.isReady === false || typeof redisClient.get !== 'function') {
    return undefined;
  }
  try {
    const raw = await redisClient.get(key);
    if (!raw) return undefined;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    writeMemoryCache(key, parsed, ttlMs);
    return parsed;
  } catch {
    // Redis unavailability falls through to Horizon (no 503)
    return undefined;
  }
};

const writeRedisCache = async (redisClient, key, value, ttlMs) => {
  if (!redisClient || redisClient.isReady === false) {
    return;
  }
  const serialized = JSON.stringify(value);
  try {
    if (typeof redisClient.pSetEx === 'function') {
      await redisClient.pSetEx(key, ttlMs, serialized);
    } else if (typeof redisClient.set === 'function' && redisClient.set.length >= 3) {
      await redisClient.set(key, serialized, { PX: ttlMs });
    } else if (typeof redisClient.setEx === 'function') {
      await redisClient.setEx(key, Math.max(1, Math.ceil(ttlMs / 1000)), serialized);
    } else if (typeof redisClient.set === 'function') {
      await redisClient.set(key, serialized, { PX: ttlMs });
    }
  } catch {
    // Ignore Redis write errors; Horizon verification already succeeded
  }
};

const evaluateCachedAccountSigners = (accountData, signerKeys, operationType = 'management') => {
  const signers = Array.isArray(accountData) ? accountData : accountData.signers || [];
  const thresholds = accountData.thresholds || {
    low_threshold: 1,
    med_threshold: 1,
    high_threshold: 1,
  };
  const requiredThreshold =
    operationType === 'high'
      ? thresholds.high_threshold
      : operationType === 'management'
        ? thresholds.med_threshold
        : thresholds.low_threshold;

  const signerMap = new Map();
  for (const s of signers) {
    signerMap.set(s.key, s.weight);
  }

  const uniqueKeys = [...new Set(signerKeys)];
  let totalWeight = 0;
  for (const key of uniqueKeys) {
    const weight = signerMap.get(key) || 0;
    if (weight > 0) totalWeight += weight;
  }

  const meetsThreshold = totalWeight >= requiredThreshold;
  return {
    success: meetsThreshold,
    totalWeight,
    requiredThreshold,
    errorMessage: meetsThreshold
      ? null
      : `Insufficient signing weight. Required: ${requiredThreshold}, Provided: ${totalWeight}`,
  };
};

/**
 * Retrieves the Horizon signer list for `address`, checking the in-memory and
 * Redis cache (`signers:<address>`) first and caching fresh results for
 * `SIGNER_CACHE_TTL_MS` milliseconds.
 */
const getCachedAccountSigners = async (
  address,
  { redisClient = _signerRedisClient, fetchFn = fetchAccountSigners, ttlMs } = {},
) => {
  const effectiveTtlMs = getEffectiveSignerCacheTtlMs(ttlMs);
  const cacheKey = `${SIGNER_CACHE_KEY_PREFIX}${address}`;

  const memHit = readMemoryCache(cacheKey);
  if (memHit !== undefined) return memHit;

  const redisHit = await readRedisCache(redisClient, cacheKey, effectiveTtlMs);
  if (redisHit !== undefined) return redisHit;

  if (typeof fetchFn !== 'function') {
    throw new Error('No signer fetcher available');
  }

  const accountDetails = await fetchFn(address);
  if (accountDetails) {
    writeMemoryCache(cacheKey, accountDetails, effectiveTtlMs);
    await writeRedisCache(redisClient, cacheKey, accountDetails, effectiveTtlMs);
  }
  return accountDetails;
};

const verifyOwnershipMultiSig = async (
  address,
  signerKeys,
  { operationType = 'management', redisClient = _signerRedisClient, ttlMs } = {},
) => {
  const effectiveTtlMs = getEffectiveSignerCacheTtlMs(ttlMs);
  const cacheKey = `${SIGNER_CACHE_KEY_PREFIX}${address}`;
  const normalizedKeys = [...new Set(signerKeys)].sort().join(',');

  // 1. Check in-memory cache
  let cached = readMemoryCache(cacheKey);

  // 2. Check Redis cache if not in memory
  if (cached === undefined) {
    cached = await readRedisCache(redisClient, cacheKey, effectiveTtlMs);
  }

  if (cached !== undefined) {
    if (cached && (Array.isArray(cached) || Array.isArray(cached.signers))) {
      return evaluateCachedAccountSigners(cached, signerKeys, operationType);
    }
    if (cached && cached.__cachedVerification && cached.keys === normalizedKeys) {
      return cached.result;
    }
  }

  const verificationResult = await verifyMultiSignerThreshold(
    address,
    signerKeys,
    { operationType },
  );

  if (verificationResult && verificationResult.success) {
    const cachePayload = Array.isArray(verificationResult.signers)
      ? {
          accountId: address,
          signers: verificationResult.signers,
          thresholds: verificationResult.thresholds,
        }
      : {
          __cachedVerification: true,
          keys: normalizedKeys,
          result: verificationResult,
        };
    writeMemoryCache(cacheKey, cachePayload, effectiveTtlMs);
    await writeRedisCache(redisClient, cacheKey, cachePayload, effectiveTtlMs);
  }

  return verificationResult;
};

const httpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

/**
 * Returns true when the supplied actor is an administrator.  Accepts either a
 * boolean flag (`isAdmin`) or a role string (`role === 'admin'`), so callers
 * can pass whatever their auth middleware exposes.
 *
 * @param {{isAdmin?: boolean, role?: string}|null|undefined} actor
 * @returns {boolean}
 */
const isAdminActor = (actor) => {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.isAdmin === true) return true;
  return typeof actor.role === 'string' && actor.role.toLowerCase() === 'admin';
};

/**
 * Extracts the owning user identifier from an export job record.  Supports the
 * common field names used across the codebase (`ownerId`, `userId`,
 * `requestedBy`) and returns `null` when none is present.
 *
 * @param {object|null|undefined} job
 * @returns {string|null}
 */
const getExportJobOwnerId = (job) => {
  if (!job || typeof job !== 'object') return null;
  const candidate = job.ownerId ?? job.userId ?? job.requestedBy ?? null;
  return candidate === null || candidate === undefined ? null : String(candidate);
};

/**
 * Extracts the acting user identifier from an authenticated actor object.
 *
 * @param {{id?: string|number, userId?: string|number, sub?: string|number}|null|undefined} actor
 * @returns {string|null}
 */
const getActorId = (actor) => {
  if (!actor || typeof actor !== 'object') return null;
  const candidate = actor.id ?? actor.userId ?? actor.sub ?? null;
  return candidate === null || candidate === undefined ? null : String(candidate);
};

/**
 * Asserts that `actor` may access `job`.  Admins may access any job; regular
 * users may only access jobs they own.
 *
 * Throws an error with `statusCode` set:
 *  - 404 when the job is missing (avoids leaking existence to non-owners)
 *  - 403 when the job exists but is owned by someone else
 *
 * @param {object|null|undefined} job
 * @param {object|null|undefined} actor
 * @returns {object} the job, for convenient chaining
 */
const assertExportJobOwnership = (job, actor) => {
  if (!job) throw httpError('Export job not found.', 404);
  if (isAdminActor(actor)) return job;

  const ownerId = getExportJobOwnerId(job);
  const actorId = getActorId(actor);

  if (!ownerId || !actorId || ownerId !== actorId) {
    throw httpError('You do not have permission to access this export job.', 403);
  }

  return job;
};

/**
 * Async variant that loads the job via `loadJob` (a function returning the job
 * or `null`) and then applies {@link assertExportJobOwnership}.  Useful for
 * route handlers that need to fetch before checking.
 *
 * @param {() => Promise<object|null>} loadJob
 * @param {object|null|undefined} actor
 * @returns {Promise<object>}
 */
const assertExportJobOwnershipById = async (loadJob, actor) => {
  if (typeof loadJob !== 'function') {
    throw httpError('Export job not found.', 404);
  }
  const job = await loadJob();
  return assertExportJobOwnership(job, actor);
};

const verifyFreighterSignedMessage = ({ message, signature, signerAddress, publicKey }) => {
  const claimedSigner = signerAddress || publicKey;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    throw httpError('Invalid signer address format.', 400);
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  let signatureBuffer;
  if (Buffer.isBuffer(signature)) {
    signatureBuffer = signature;
  } else if (typeof signature === 'string') {
    signatureBuffer = Buffer.from(signature, 'base64');
  } else {
    throw new Error('Invalid message signature format.');
  }

  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const messageBytes = Buffer.from(message, 'utf8');
  const payload = Buffer.concat([prefix, messageBytes]);
  const messageHash = crypto.createHash('sha256').update(payload).digest();

  if (!keypair.verify(messageHash, signatureBuffer)) {
    throw httpError('Signature verification failed.', 401);
  }

  if (claimedSigner !== publicKey) {
    throw httpError('Signer address does not match the registered account.', 401);
  }

  return claimedSigner;
};

const findUserRecord = async (username) => {
  try {
    return await prisma.user.findUnique({
      where: { username },
      select: { username: true, address: true },
    });
  } catch (err) {
    if (!shouldFallbackToLocalRegistry(err)) throw err;
    const localRow = await poolGet(
      'SELECT username, address FROM username_registry WHERE username = $1 LIMIT 1',
      [username],
    );
    return localRow ? { username: localRow.username, address: localRow.address } : null;
  }
};

/**
 * Returns true when `value` is a single valid Ed25519 public key string.
 * @param {unknown} value
 * @returns {boolean}
 */
const isSignerAddress = (value) =>
  typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);

/**
 * Returns true when `value` is a non-empty array of valid Ed25519 public
 * key strings (multi-sig threshold proof with multiple co-signer addresses).
 * @param {unknown} value
 * @returns {boolean}
 */
const isSignerAddressArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((v) => typeof v === 'string' && StrKey.isValidEd25519PublicKey(v));

/**
 * @returns {Promise<{username: string, address: string}>} the authenticated user
 * @throws {Error} with `statusCode` set on any failure
 */
const authenticateUsernameOwner = async ({
  username: rawUsername,
  signature: rawSignature,
  signerAddress: rawSignerAddress,
  operation = 'webhook',
  redisClient,
  ttlMs,
}) => {
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const signerAddress =
    typeof rawSignerAddress === 'string' ? rawSignerAddress.trim() : undefined;

  // Normalise signature: strings are trimmed, arrays are passed through as-is.
  let signature;
  if (Array.isArray(rawSignature)) {
    signature = rawSignature;
  } else if (typeof rawSignature === 'string') {
    signature = rawSignature.trim();
  } else {
    signature = rawSignature;
  }

  if (!username) throw httpError('Missing required field: username.', 400);

  // A missing/empty signature is invalid regardless of type.
  const isMissing =
    signature === '' ||
    signature === null ||
    signature === undefined ||
    (Array.isArray(signature) && signature.length === 0);
  if (isMissing) throw httpError('Missing required field: signature.', 400);

  const normalizedUsername = normalizeNameTag(username).toLowerCase();
  const userRecord = await findUserRecord(normalizedUsername);

  if (!userRecord) throw httpError('Username not registered.', 404);

  const message = `${operation}:${normalizedUsername}`;

  // ── Path 1: multi-sig with an array of co-signer addresses ─────────────
  // Caller provides multiple signer public keys to satisfy a threshold
  // (e.g. 2-of-3).  All keys are forwarded to verifyMultiSignerThreshold
  // so the module can compute the combined signing weight.
  if (isSignerAddressArray(signature)) {
    const verificationResult = await verifyOwnershipMultiSig(
      userRecord.address,
      signature,
      { operationType: 'management', redisClient, ttlMs },
    );
    if (!verificationResult.success) {
      throw httpError(verificationResult.errorMessage || 'Signature verification failed', 401);
    }
    return userRecord;
  }

  // ── Path 2: multi-sig with a single signer address ──────────────────────
  // Caller provides one co-signer public key.  The verifier will check
  // whether that key's weight alone meets the account's threshold.
  if (isSignerAddress(signature) && !signerAddress) {
    const verificationResult = await verifyOwnershipMultiSig(
      userRecord.address,
      [signature],
      { operationType: 'management', redisClient, ttlMs },
    );
    if (!verificationResult.success) {
      throw httpError(verificationResult.errorMessage || 'Signature verification failed', 401);
    }
    return userRecord;
  }

  // ── Path 3: Freighter / single-signer Ed25519 signature ─────────────────
  // Standard accounts use a base64-encoded cryptographic signature produced
  // by the Freighter wallet (or equivalent) over the prefixed message hash.
  verifyFreighterSignedMessage({
    message,
    signature,
    signerAddress,
    publicKey: userRecord.address,
  });

  return userRecord;
};

module.exports = {
  authenticateUsernameOwner,
  verifyFreighterSignedMessage,
  getCachedAccountSigners,
  setSignerRedisClient,
  clearSignerCache,
  SIGNER_CACHE_TTL_MS,
  SIGNER_CACHE_KEY_PREFIX,
  _signerMemoryCache,
  // Export job ownership helpers
  isAdminActor,
  getExportJobOwnerId,
  getActorId,
  assertExportJobOwnership,
  assertExportJobOwnershipById,
};
