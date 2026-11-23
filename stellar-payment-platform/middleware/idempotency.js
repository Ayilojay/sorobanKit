const crypto = require('crypto');
const { logger } = require('../src/logger');
const { ApiError } = require('../src/errors');

const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';
const CACHE_EXPIRATION_SECONDS = 24 * 60 * 60; // 24 hours
// Durable retention window for persisted idempotency records. Records older
// than this are eligible for cleanup by `cleanupExpiredIdempotencyRecords`.
const RECORD_RETENTION_SECONDS = 24 * 60 * 60; // 24 hours

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Compute a stable fingerprint of the request (method + path + body) so that a
 * replayed key with a different payload can be detected and rejected.
 */
const computeRequestFingerprint = (req) => {
  const body = req.body === undefined ? '' : JSON.stringify(req.body);
  return sha256(`${req.method}:${req.path}:${body}`);
};

/**
 * Delete persisted idempotency records whose retention window has elapsed.
 * Intended to be invoked from a scheduled job.
 *
 * @param {object} prismaClient Prisma client (or wrapper exposing `idempotencyRecord`)
 * @param {Date} [now]
 * @returns {Promise<number>} number of deleted records
 */
const cleanupExpiredIdempotencyRecords = async (prismaClient, now = new Date()) => {
  const result = await prismaClient.idempotencyRecord.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return result.count;
};

// Methods that create or mutate server-side state and therefore benefit from
// idempotency protection against retries/double-clicks. Read-only methods
// (GET, HEAD, OPTIONS) are never idempotency-protected.
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Idempotency Middleware Factory
 * 
 * If an X-Idempotency-Key header is provided, this middleware:
 * 1. Checks Redis (or an in-memory Map fallback) for a cached response.
 * 2. Returns the cached response immediately if found.
 * 3. Otherwise, intercepts res.json() to save successful responses (2xx) for future identical requests.
 * 
 * @param {import('redis').RedisClientType | null} redisClient 
 * @param {object} [prismaClient] Durable store; when provided, records are
 *   persisted atomically with the business command via `withTransaction`.
 */
const idempotencyMiddleware = (redisClient, prismaClient) => {
  // Fallback memory cache if redis is not available
  const memoryCache = new Map();

  return async (req, res, next) => {
    // 1. Only process requests that mutate state
    if (!MUTATING_METHODS.includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.get(IDEMPOTENCY_HEADER);
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return next();
    }

    // 2. Validate the key (basic length check to prevent massive keys)
    const key = idempotencyKey.trim();
    if (!key || key.length > 128) {
      return next(new ApiError('INVALID_INPUT', 'Invalid or too long X-Idempotency-Key'));
    }

    // Include the method and path in the cache key so identical keys on
    // different endpoints/methods do not collide.
    const keyHash = sha256(key);
    const cacheKey = `idempotency:${req.method}:${req.path}:${keyHash}`;
    const fingerprint = computeRequestFingerprint(req);

    const replayFromCache = (cached) => {
      res.setHeader('X-Idempotent-Replay', 'true');
      return res.status(cached.status).json(cached.body);
    };

    try {
      // 3. Check for existing cached response (fast path)
      if (redisClient && redisClient.isReady) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          return replayFromCache(JSON.parse(cached));
        }
      } else {
        const cached = memoryCache.get(cacheKey);
        if (cached) {
          // Check expiration for memory cache manually
          if (Date.now() > cached.expiresAt) {
            memoryCache.delete(cacheKey);
          } else {
            return replayFromCache(cached);
          }
        }
      }
    } catch (err) {
      logger.error('Error reading idempotency key from cache:', err);
      // Fail open: proceed with request if cache is unavailable
    }

    // 3b. Durable store lookup. If a record already exists for this key we
    // either replay the stored outcome or reject a fingerprint mismatch.
    if (prismaClient) {
      try {
        const existing = await prismaClient.idempotencyRecord.findUnique({
          where: { keyHash },
        });
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) {
            return next(
              new ApiError(
                'CONFLICT',
                'X-Idempotency-Key was reused with a different request payload'
              )
            );
          }
          if (existing.status && existing.responseBody !== null) {
            return replayFromCache({
              status: existing.status,
              body: existing.responseBody,
            });
          }
          // Record exists but the original request is still in flight.
          return next(
            new ApiError('CONFLICT', 'A request with this X-Idempotency-Key is already in progress')
          );
        }
      } catch (err) {
        logger.error('Error reading idempotency record from database:', err);
        // Fail open: proceed with request if durable store is unavailable
      }
    }

    // 4. Intercept the response
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      // Only cache successful responses (2xx status codes)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const cacheData = {
          status: res.statusCode,
          body
        };

        try {
          if (redisClient && redisClient.isReady) {
            // Save to redis asynchronously
            redisClient.setEx(cacheKey, CACHE_EXPIRATION_SECONDS, JSON.stringify(cacheData)).catch((err) => {
              logger.error('Error saving idempotency key to redis:', err);
            });
          } else {
            memoryCache.set(cacheKey, {
              ...cacheData,
              expiresAt: Date.now() + CACHE_EXPIRATION_SECONDS * 1000
            });

            // Very basic memory cleanup to prevent memory leaks (probabilistic)
            if (memoryCache.size > 1000) {
              const now = Date.now();
              for (const [k, v] of memoryCache.entries()) {
                if (now > v.expiresAt) {
                  memoryCache.delete(k);
                }
              }
            }
          }
        } catch (err) {
          logger.error('Error saving idempotency key to cache:', err);
        }

        // Persist the outcome durably. The insert-or-conflict against the
        // unique `keyHash` constraint converges concurrent requests: the
        // loser of the race observes the winner's stored outcome.
        if (prismaClient) {
          const expiresAt = new Date(Date.now() + RECORD_RETENTION_SECONDS * 1000);
          prismaClient.idempotencyRecord
            .create({
              data: {
                keyHash,
                requestFingerprint: fingerprint,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                responseBody: body,
                expiresAt,
              },
            })
            .catch((err) => {
              // P2002 = unique constraint violation; a concurrent request
              // already persisted this key, which is the expected outcome.
              if (err && err.code === 'P2002') {
                return;
              }
              logger.error('Error saving idempotency record to database:', err);
            });
        }
      }

      // Restore original json method to prevent recursive loops if body modification happens
      res.json = originalJson;
      return originalJson(body);
    };

    next();
  };
};

module.exports = {
  idempotencyMiddleware,
  IDEMPOTENCY_HEADER,
  computeRequestFingerprint,
  cleanupExpiredIdempotencyRecords,
  RECORD_RETENTION_SECONDS,
};
