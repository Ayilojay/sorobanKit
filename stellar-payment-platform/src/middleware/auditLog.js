'use strict';

/**
 * src/middleware/auditLog.js
 *
 * Middleware to intercept mutating requests (POST, PUT, DELETE, PATCH)
 * and asynchronously record audit logs in the database.
 */

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
  'challenge',
  'challengeid',
  'challenge_id',
  'challengesecret',
  'challenge_secret',
  'stepup',
  'step_up',
  'stepuptoken',
  'step_up_token',
  'otp',
  'totp',
  'rawkey',
  'raw_key',
  'keymaterial',
  'key_material',
]);

const REDACTED_PLACEHOLDER = '[REDACTED]';

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
 * Extracts the resolved permission and actor role attached to the request by
 * the authorization middleware. These are populated by policy-based role
 * resolution (see admin authorization middleware) and are safe to persist.
 *
 * @param {import('express').Request} req
 * @returns {{ permission: string|null, role: string|null }}
 */
const extractAuthorizationContext = (req) => {
  const permission =
    req.authz?.permission || req.permission || req.resolvedPermission || null;
  const role = req.authz?.role || req.user?.role || req.adminRole || null;
  return {
    permission: permission ? String(permission) : null,
    role: role ? String(role) : null,
  };
};

/**
 * Extracts step-up verification evidence attached to the request.
 *
 * Only the challenge identifier is persisted — never the challenge secret or
 * any raw verification material.
 *
 * @param {import('express').Request} req
 * @returns {{ stepUpChallengeId: string|null, stepUpVerified: boolean|null }}
 */
const extractStepUpContext = (req) => {
  const stepUp = req.stepUp || req.authz?.stepUp || null;
  const challengeId = stepUp?.challengeId || stepUp?.id || req.stepUpChallengeId || null;
  const verified =
    typeof stepUp?.verified === 'boolean'
      ? stepUp.verified
      : typeof req.stepUpVerified === 'boolean'
        ? req.stepUpVerified
        : null;
  return {
    stepUpChallengeId: challengeId ? String(challengeId) : null,
    stepUpVerified: verified,
  };
};

/**
 * Derives the outcome and failure reason for an audited request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {{ outcome: string, failureReason: string|null }}
 */
const extractOutcome = (req, res) => {
  const statusCode = res.statusCode;
  const explicitReason =
    req.auditFailureReason || req.authz?.failureReason || req.stepUp?.failureReason || null;

  if (statusCode >= 200 && statusCode < 400) {
    return { outcome: 'success', failureReason: null };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { outcome: 'denied', failureReason: explicitReason ? String(explicitReason) : null };
  }
  if (statusCode === 409) {
    return { outcome: 'conflict', failureReason: explicitReason ? String(explicitReason) : null };
  }
  if (statusCode === 429) {
    return { outcome: 'throttled', failureReason: explicitReason ? String(explicitReason) : null };
  }
  return { outcome: 'failure', failureReason: explicitReason ? String(explicitReason) : null };
};

/**
 * Creates Express middleware for audit logging mutating requests.
 *
 * @param {object} [opts]
 * @param {object} [opts.prismaClient] - Prisma client instance (defaults to shared prisma).
 * @param {Array<string>} [opts.methods=['POST', 'PUT', 'DELETE', 'PATCH']] - Methods to audit.
 * @returns {import('express').RequestHandler}
 */
const createAuditLogMiddleware = (opts = {}) => {
  const targetMethods = new Set(
    (opts.methods || ['POST', 'PUT', 'DELETE', 'PATCH']).map((m) => m.toUpperCase()),
  );

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
    const { permission, role } = extractAuthorizationContext(req);
    const { stepUpChallengeId, stepUpVerified } = extractStepUpContext(req);

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
      setImmediate(async () => {
        try {
          if (prisma?.auditLog?.create) {
            const { outcome, failureReason } = extractOutcome(req, res);
            const payloadHash =
              req.auditPayloadHash || req.authz?.payloadHash || req.stepUp?.payloadHash || null;

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
                permission,
                role,
                stepUpChallengeId,
                stepUpVerified,
                payloadHash: payloadHash ? String(payloadHash) : null,
                outcome,
                failureReason,
              },
            });
          }
        } catch (err) {
          logger.error(`[auditLog] Failed to persist audit log for ${action}:`, err);
        }
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
  extractAuthorizationContext,
  extractStepUpContext,
  extractOutcome,
  SENSITIVE_KEYS,
  REDACTED_PLACEHOLDER,
};
