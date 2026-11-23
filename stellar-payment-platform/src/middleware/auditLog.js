'use strict';

/**
 * src/middleware/auditLog.js
 *
 * Middleware to intercept mutating requests (POST, PUT, DELETE, PATCH)
 * and asynchronously record audit logs in the database.
 */

const crypto = require('crypto');
const { logger } = require('../logger');

const SENSITIVE_KEYS = Object.freeze([
  'password',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'signature',
  'privatekey',
  'private_key',
  'seed',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
]);

const REDACTED_PLACEHOLDER = '[REDACTED]';

const DEFAULT_KEY_ID = 'v1';
const DIGEST_ALGORITHM = 'sha256';

/**
 * Deterministically serializes a value to canonical JSON.
 *
 * Object keys are sorted lexicographically at every level, arrays preserve
 * order, and primitives are serialized via JSON.stringify. This guarantees
 * that logically identical payloads always produce identical byte sequences,
 * which is required for stable integrity digests.
 *
 * @param {*} value
 * @returns {string}
 */
const canonicalize = (value) => {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const entries = keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON.stringify would emit null; keep canonical output valid JSON.
    return 'null';
  }

  return JSON.stringify(value);
};

/**
 * Resolves the key material used for signing.
 *
 * Supports a primary (current) key and an optional previous key so that
 * verification can continue across key rotation windows.
 *
 * @param {object} [opts]
 * @param {string} [opts.keyId]
 * @param {string|Buffer} [opts.key]
 * @param {string} [opts.previousKeyId]
 * @param {string|Buffer} [opts.previousKey]
 * @returns {{keyId: string, key: string|Buffer, previousKeyId: (string|null), previousKey: (string|Buffer|null)}}
 */
const resolveSigningKeys = (opts = {}) => {
  const key = opts.key || process.env.AUDIT_LOG_HMAC_KEY;
  if (!key) {
    throw new Error('[auditLog] AUDIT_LOG_HMAC_KEY (or opts.key) is required for integrity signing');
  }

  const keyId = opts.keyId || process.env.AUDIT_LOG_HMAC_KEY_ID || DEFAULT_KEY_ID;
  const previousKey = opts.previousKey || process.env.AUDIT_LOG_HMAC_PREVIOUS_KEY || null;
  const previousKeyId =
    opts.previousKeyId || process.env.AUDIT_LOG_HMAC_PREVIOUS_KEY_ID || (previousKey ? 'previous' : null);

  return { keyId, key, previousKeyId, previousKey };
};

/**
 * Computes the HMAC-SHA256 integrity digest for an audit event.
 *
 * The digest covers the previous digest (chain link), the canonical payload,
 * and the key identifier so that key rotation is itself tamper-evident.
 *
 * @param {object} params
 * @param {string|null} params.prevDigest
 * @param {*} params.payload
 * @param {string} params.keyId
 * @param {string|Buffer} params.key
 * @returns {string} hex digest
 */
const computeAuditDigest = ({ prevDigest, payload, keyId, key }) => {
  const canonicalPayload = canonicalize(payload === undefined ? null : payload);
  const message = canonicalize({
    prevDigest: prevDigest || null,
    payload: canonicalPayload,
    keyId,
  });
  return crypto.createHmac(DIGEST_ALGORITHM, key).update(message, 'utf8').digest('hex');
};

/**
 * Verifies a single audit event digest against the supplied key material.
 *
 * @param {object} event - Audit row containing prevDigest, payload, keyId, digest.
 * @param {object} keys - Result of resolveSigningKeys.
 * @returns {boolean}
 */
const verifyAuditDigest = (event, keys) => {
  if (!event || typeof event.digest !== 'string') return false;

  const candidates = [];
  if (event.keyId === keys.keyId || !event.keyId) {
    candidates.push({ keyId: keys.keyId, key: keys.key });
  }
  if (keys.previousKey && (event.keyId === keys.previousKeyId || !event.keyId)) {
    candidates.push({ keyId: keys.previousKeyId, key: keys.previousKey });
  }

  let payload = event.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      // keep raw string; canonicalize handles it deterministically
    }
  }

  return candidates.some((candidate) => {
    const expected = computeAuditDigest({
      prevDigest: event.prevDigest || null,
      payload,
      keyId: candidate.keyId,
      key: candidate.key,
    });
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(event.digest, 'hex'));
  });
};

/**
 * Verifies an ordered list of audit events, checking both per-event digests
 * and the prevDigest chain linkage.
 *
 * @param {Array<object>} events - Ordered oldest-first.
 * @param {object} keys - Result of resolveSigningKeys.
 * @returns {{valid: boolean, brokenAt: (number|null), reason: (string|null)}}
 */
const verifyAuditChain = (events, keys) => {
  let prevDigest = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if ((event.prevDigest || null) !== prevDigest) {
      return { valid: false, brokenAt: i, reason: 'prevDigest mismatch' };
    }
    if (!verifyAuditDigest(event, keys)) {
      return { valid: false, brokenAt: i, reason: 'digest mismatch' };
    }
    prevDigest = event.digest;
  }
  return { valid: true, brokenAt: null, reason: null };
};

const SENSITIVE_REGEX = new RegExp(
  `^(${SENSITIVE_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  'i',
);

/**
 * Deeply redacts sensitive fields from objects or arrays.
 *
 * @param {*} data
 * @returns {*} Redacted clone of data.
 */
const redactSensitiveData = (data) => {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(redactSensitiveData(parsed));
      }
    } catch {
      // not JSON string, return as is
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  if (typeof data === 'object') {
    const redacted = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_REGEX.test(key)) {
        redacted[key] = REDACTED_PLACEHOLDER;
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted;
  }

  return data;
};

/**
 * Extracts the user/admin ID from the request.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const extractUserId = (req) => {
  if (req.user?.id) return String(req.user.id);
  if (req.user?.username) return String(req.user.username);
  if (req.headers['x-user-id']) return String(req.headers['x-user-id']);
  if (req.headers['x-admin-id']) return String(req.headers['x-admin-id']);
  if (req.headers['x-api-key'] || req.query?.api_key) return 'admin';
  return 'anonymous';
};

/**
 * Extracts client IP address safely.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const extractIpAddress = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

/**
 * Creates Express middleware for audit logging mutating requests.
 *
 * @param {object} [opts]
 * @param {object} [opts.prismaClient] - Prisma client instance (defaults to shared prisma).
 * @param {Array<string>} [opts.methods=['POST', 'PUT', 'DELETE', 'PATCH']] - Methods to audit.
 * @param {string} [opts.key] - HMAC key (defaults to AUDIT_LOG_HMAC_KEY env).
 * @param {string} [opts.keyId] - Key identifier (defaults to AUDIT_LOG_HMAC_KEY_ID env).
 * @param {string} [opts.previousKey] - Previous HMAC key for rotation windows.
 * @param {string} [opts.previousKeyId] - Previous key identifier.
 * @returns {import('express').RequestHandler}
 */
const createAuditLogMiddleware = (opts = {}) => {
  const targetMethods = new Set(
    (opts.methods || ['POST', 'PUT', 'DELETE', 'PATCH']).map((m) => m.toUpperCase()),
  );

  // Resolve signing keys eagerly so misconfiguration fails fast at startup.
  const signingKeys = resolveSigningKeys(opts);

  // Serializes digest computation + persistence so the chain stays linear
  // even under concurrent requests.
  let chainTail = Promise.resolve();
  let lastDigest = null;

  return (req, res, next) => {
    if (!targetMethods.has(req.method.toUpperCase())) {
      return next();
    }

    const prisma = opts.prismaClient || require('../../prismaClient').prisma;
    const ipAddress = extractIpAddress(req);
    const userId = extractUserId(req);
    const method = req.method.toUpperCase();
    const path = req.originalUrl || req.url || req.path;
    const action = `${method} ${req.baseUrl || ''}${req.path || ''}`.trim() || `${method} ${path}`;
    const userAgent = req.headers['user-agent'] || null;

    // Snapshot redacted body at request time
    let redactedPayload = null;
    try {
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        redactedPayload = JSON.stringify(redactSensitiveData(req.body));
      }
    } catch (err) {
      logger.warn(`[auditLog] Failed to serialize request body: ${err.message}`);
    }

    // Intercept response finish asynchronously
    res.on('finish', () => {
      // Async write to database — must never block or crash
      setImmediate(() => {
        chainTail = chainTail.then(async () => {
          try {
            if (prisma?.auditLog?.create) {
              const prevDigest = lastDigest;
              const digest = computeAuditDigest({
                prevDigest,
                payload: redactedPayload,
                keyId: signingKeys.keyId,
                key: signingKeys.key,
              });

              await prisma.auditLog.create({
                data: {
                  action,
                  method,
                  path,
                  userId,
                  ipAddress,
                  userAgent,
                  statusCode: res.statusCode,
                  payload: redactedPayload,
                  digest,
                  prevDigest,
                  keyId: signingKeys.keyId,
                },
              });

              lastDigest = digest;
            }
          } catch (err) {
            logger.error(`[auditLog] Failed to persist audit log for ${action}:`, err);
          }
        });
      });
    });

    return next();
  };
};

const auditLogMiddleware = createAuditLogMiddleware();

module.exports = {
  createAuditLogMiddleware,
  auditLogMiddleware,
  redactSensitiveData,
  extractUserId,
  extractIpAddress,
  canonicalize,
  computeAuditDigest,
  verifyAuditDigest,
  verifyAuditChain,
  resolveSigningKeys,
  SENSITIVE_KEYS,
  REDACTED_PLACEHOLDER,
  DEFAULT_KEY_ID,
  DIGEST_ALGORITHM,
};
