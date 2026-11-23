const crypto = require('crypto');
const { logger } = require('./logger');

const FEDERATION_CACHE_TTL = 300;
const FEDERATION_CACHE_PREFIX = 'federation';

// Version namespace for the federation ETag algorithm. Bump this whenever the
// canonical serialization changes so previously issued validators are not
// incorrectly considered fresh.
const FEDERATION_ETAG_VERSION = 'v1';

// Cache key holding the current validator generation. User mutations bump the
// generation, which invalidates every previously issued ETag at once without
// having to enumerate individual entries.
const FEDERATION_ETAG_GENERATION_KEY = `${FEDERATION_CACHE_PREFIX}:etag:generation`;

// Authorization-dependent federation responses must never be shared-cached.
// These headers are applied to every federation response that carries a
// validator so intermediaries and clients do not reuse it across principals.
const FEDERATION_PRIVATE_CACHE_CONTROL = 'private, no-cache';

function canonicalizeFederationValue(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeFederationValue).join(',')}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeFederationValue(value[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeFederationETag(type, value, payload, generation) {
  const canonical = canonicalizeFederationValue({
    version: FEDERATION_ETAG_VERSION,
    type: String(type).toLowerCase(),
    value: String(value).toLowerCase(),
    generation: generation === undefined || generation === null ? null : String(generation),
    payload: payload === undefined ? null : payload,
  });

  const digest = crypto.createHash('sha256').update(canonical).digest('base64url');
  return `"${FEDERATION_ETAG_VERSION}-${digest}"`;
}

function normalizeETag(etag) {
  if (!etag || typeof etag !== 'string') return null;
  let normalized = etag.trim();
  if (normalized.startsWith('W/')) normalized = normalized.slice(2);
  if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
    normalized = normalized.slice(1, -1);
  }
  return normalized || null;
}

function etagMatches(ifNoneMatchHeader, etag) {
  if (!ifNoneMatchHeader || !etag) return false;

  const candidates = String(ifNoneMatchHeader)
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  if (candidates.includes('*')) return true;

  const target = normalizeETag(etag);
  if (!target) return false;

  return candidates.some((candidate) => normalizeETag(candidate) === target);
}

function buildFederationCacheHeaders(etag) {
  const headers = {
    'Cache-Control': FEDERATION_PRIVATE_CACHE_CONTROL,
    Vary: 'Authorization',
  };
  if (etag) headers.ETag = etag;
  return headers;
}

async function getFederationETagGeneration(redisClient) {
  if (!redisClient || !redisClient.isReady) return null;
  try {
    const generation = await redisClient.get(FEDERATION_ETAG_GENERATION_KEY);
    return generation === null || generation === undefined ? null : String(generation);
  } catch (err) {
    logger.error('Error reading federation ETag generation from Redis:', err);
    return null;
  }
}

async function bumpFederationETagGeneration(redisClient) {
  if (!redisClient || !redisClient.isReady) return null;
  try {
    const generation = await redisClient.incr(FEDERATION_ETAG_GENERATION_KEY);
    return String(generation);
  } catch (err) {
    logger.error('Error bumping federation ETag generation in Redis:', err);
    return null;
  }
}

function buildFederationCacheKey(type, value) {
  return `${FEDERATION_CACHE_PREFIX}:${type}:${value.toLowerCase()}`;
}

async function getCachedFederationResult(redisClient, cacheKey, fetchFn) {
  if (redisClient && redisClient.isReady) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.error('Error reading federation cache from Redis:', err);
    }
  }

  const result = await fetchFn();

  if (result !== null && redisClient && redisClient.isReady) {
    redisClient.setEx(cacheKey, FEDERATION_CACHE_TTL, JSON.stringify(result))
      .catch((err) => logger.error('Error saving federation cache to Redis:', err));
  }

  return result;
}

async function invalidateFederationCache(redisClient, address, username) {
  if (!redisClient || !redisClient.isReady) return;

  const keys = [];
  if (address) keys.push(buildFederationCacheKey('id', address));
  if (username) keys.push(buildFederationCacheKey('name', username));

  if (keys.length > 0) {
    try {
      await redisClient.del(keys);
    } catch (err) {
      logger.error('Error invalidating federation cache:', err);
    }
  }

  // User mutations change resolved federation data, so previously issued
  // validators must no longer be considered fresh.
  await bumpFederationETagGeneration(redisClient);
}

async function delFederationCacheEntry(redisClient, username) {
  if (!redisClient || !redisClient.isReady) return;

  if (!username) return;

  const keys = [buildFederationCacheKey('name', username)];

  try {
    await redisClient.del(keys);
  } catch (err) {
    // Swallow the error: TTL-based eviction remains as a fallback so a Redis
    // failure does not break unregistration.
    logger.error('Error deleting federation cache entry:', err);
  }

  await bumpFederationETagGeneration(redisClient);
}

module.exports = {
  FEDERATION_CACHE_TTL,
  FEDERATION_CACHE_PREFIX,
  FEDERATION_ETAG_VERSION,
  FEDERATION_ETAG_GENERATION_KEY,
  FEDERATION_PRIVATE_CACHE_CONTROL,
  buildFederationCacheKey,
  getCachedFederationResult,
  invalidateFederationCache,
  delFederationCacheEntry,
  canonicalizeFederationValue,
  computeFederationETag,
  normalizeETag,
  etagMatches,
  buildFederationCacheHeaders,
  getFederationETagGeneration,
  bumpFederationETagGeneration,
};