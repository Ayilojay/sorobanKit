'use strict';

/**
 * Step-up verification service and middleware.
 *
 * High-impact administrative actions (contract upgrades, treasury changes,
 * bulk exports) require a short-lived, single-use second confirmation that is
 * bound to both the action name and a hash of the request payload. This module
 * provides:
 *
 *   - issueChallenge(userId, action, payloadHash)
 *       Creates a short-lived, single-use nonce bound to action + payload hash.
 *   - verifyAndConsume(challengeId, action, payloadHash)
 *       Atomically verifies and consumes a challenge. Rejects expired, reused,
 *       mismatched, or unknown challenges.
 *   - requireStepUp(action, payloadHashResolver)
 *       Express middleware returning 401/403/409 with defined failure codes and
 *       recording audit evidence (challenge id, action, payload hash, outcome,
 *       expiry).
 *
 * Storage is pluggable. A default in-memory store is provided for tests and
 * single-process deployments; production deployments should inject a
 * transactional store (e.g. a database) that guarantees the atomic
 * "consume if not yet consumed" semantics.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_HEADER = 'x-step-up-challenge';

const FAILURE_CODES = Object.freeze({
  MISSING_CHALLENGE: 'STEP_UP_MISSING_CHALLENGE',
  UNAUTHENTICATED: 'STEP_UP_UNAUTHENTICATED',
  FORBIDDEN: 'STEP_UP_FORBIDDEN',
  UNKNOWN_CHALLENGE: 'STEP_UP_UNKNOWN_CHALLENGE',
  EXPIRED_CHALLENGE: 'STEP_UP_EXPIRED_CHALLENGE',
  REUSED_CHALLENGE: 'STEP_UP_REUSED_CHALLENGE',
  MISMATCHED_CHALLENGE: 'STEP_UP_MISMATCHED_CHALLENGE',
  INVALID_PAYLOAD_HASH: 'STEP_UP_INVALID_PAYLOAD_HASH',
});

const OUTCOMES = Object.freeze({
  ISSUED: 'issued',
  SUCCESS: 'success',
  MISSING: 'missing',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  UNKNOWN: 'unknown',
  EXPIRED: 'expired',
  REUSED: 'reused',
  MISMATCHED: 'mismatched',
  INVALID_PAYLOAD_HASH: 'invalid_payload_hash',
});

/**
 * Compute a stable SHA-256 hex hash for a payload. Accepts a string/Buffer or
 * any JSON-serializable value (objects are serialized with sorted keys so the
 * hash is deterministic).
 */
function hashPayload(payload) {
  let input;
  if (payload === undefined || payload === null) {
    input = '';
  } else if (Buffer.isBuffer(payload)) {
    input = payload;
  } else if (typeof payload === 'string') {
    input = payload;
  } else {
    input = stableStringify(payload);
  }
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') +
    '}'
  );
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isHexHash(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
}

/**
 * In-memory challenge store. Implements the minimal interface required by the
 * service:
 *   - create(record)
 *   - get(challengeId)
 *   - consumeIfActive(challengeId, now) -> { record, consumed } | null
 *
 * `consumeIfActive` must be atomic. In a single-threaded Node process the
 * synchronous implementation below is atomic with respect to other JS code.
 * For multi-process deployments, inject a store backed by a database with a
 * conditional UPDATE (e.g. `UPDATE ... SET consumed_at = now WHERE id = $1 AND
 * consumed_at IS NULL`).
 */
class InMemoryChallengeStore {
  constructor() {
    this._records = new Map();
  }

  create(record) {
    this._records.set(record.challengeId, { ...record });
    return { ...record };
  }

  get(challengeId) {
    const rec = this._records.get(challengeId);
    return rec ? { ...rec } : null;
  }

  consumeIfActive(challengeId, now) {
    const rec = this._records.get(challengeId);
    if (!rec) return null;
    if (rec.consumedAt !== null) {
      return { record: { ...rec }, consumed: false };
    }
    rec.consumedAt = now;
    return { record: { ...rec }, consumed: true };
  }

  clear() {
    this._records.clear();
  }
}

/**
 * Audit sink interface: record(entry). Default is a no-op so callers can opt in.
 */
class NoopAuditSink {
  record() {}
}

class StepUpService {
  /**
   * @param {object} [options]
   * @param {object} [options.store] - challenge store (defaults to in-memory)
   * @param {object} [options.auditSink] - audit sink (defaults to no-op)
   * @param {number} [options.ttlMs] - challenge lifetime in ms
   * @param {() => number} [options.now] - clock injection for tests
   */
  constructor(options = {}) {
    this.store = options.store || new InMemoryChallengeStore();
    this.auditSink = options.auditSink || new NoopAuditSink();
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  _audit(entry) {
    try {
      this.auditSink.record({ timestamp: new Date(this.now()).toISOString(), ...entry });
    } catch (_err) {
      // Audit failures must never break the security decision path.
    }
  }

  /**
   * Issue a short-lived, single-use challenge bound to action + payload hash.
   *
   * @param {string} userId
   * @param {string} action
   * @param {string} payloadHash - hex SHA-256 of the payload
   * @returns {{ challengeId: string, action: string, payloadHash: string, expiresAt: string, ttlMs: number }}
   */
  issueChallenge(userId, action, payloadHash) {
    if (!isNonEmptyString(userId)) {
      throw new StepUpError(400, 'STEP_UP_INVALID_USER', 'userId is required');
    }
    if (!isNonEmptyString(action)) {
      throw new StepUpError(400, 'STEP_UP_INVALID_ACTION', 'action is required');
    }
    if (!isHexHash(payloadHash)) {
      throw new StepUpError(
        400,
        FAILURE_CODES.INVALID_PAYLOAD_HASH,
        'payloadHash must be a hex SHA-256 digest'
      );
    }

    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;
    const challengeId = crypto.randomBytes(32).toString('hex');

    const record = {
      challengeId,
      userId,
      action,
      payloadHash: payloadHash.toLowerCase(),
      issuedAt,
      expiresAt,
      consumedAt: null,
    };

    this.store.create(record);

    this._audit({
      event: 'step_up.challenge_issued',
      challengeId,
      userId,
      action,
      payloadHash: record.payloadHash,
      outcome: OUTCOMES.ISSUED,
      expiresAt: new Date(expiresAt).toISOString(),
    });

    return {
      challengeId,
      action,
      payloadHash: record.payloadHash,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlMs: this.ttlMs,
    };
  }

  /**
   * Atomically verify and consume a challenge.
   *
   * @param {string} challengeId
   * @param {string} action
   * @param {string} payloadHash
   * @param {object} [context] - optional { userId } for ownership checks
   * @returns {{ ok: true, record: object } | { ok: false, code: string, status: number, message: string }}
   */
  verifyAndConsume(challengeId, action, payloadHash, context = {}) {
    const now = this.now();

    if (!isNonEmptyString(challengeId)) {
      return this._fail(FAILURE_CODES.MISSING_CHALLENGE, 401, 'Step-up challenge is required', {
        challengeId: challengeId || null,
        action,
        payloadHash,
        outcome: OUTCOMES.MISSING,
      });
    }

    if (!isHexHash(payloadHash)) {
      return this._fail(
        FAILURE_CODES.INVALID_PAYLOAD_HASH,
        400,
        'payloadHash must be a hex SHA-256 digest',
        {
          challengeId,
          action,
          payloadHash: payloadHash || null,
          outcome: OUTCOMES.INVALID_PAYLOAD_HASH,
        }
      );
    }

    const normalizedHash = payloadHash.toLowerCase();

    // Atomic consume-if-active. The store guarantees only one caller observes
    // `consumed: true` for a given challenge.
    const result = this.store.consumeIfActive(challengeId, now);

    if (!result) {
      return this._fail(FAILURE_CODES.UNKNOWN_CHALLENGE, 403, 'Unknown step-up challenge', {
        challengeId,
        action,
        payloadHash: normalizedHash,
        outcome: OUTCOMES.UNKNOWN,
      });
    }

    const { record, consumed } = result;

    // Reused: already consumed previously.
    if (!consumed) {
      return this._fail(FAILURE_CODES.REUSED_CHALLENGE, 409, 'Step-up challenge already used', {
        challengeId,
        action,
        payloadHash: normalizedHash,
        outcome: OUTCOMES.REUSED,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    }

    // From here on the challenge is consumed; any failure is terminal.
    if (record.expiresAt <= now) {
      return this._fail(FAILURE_CODES.EXPIRED_CHALLENGE, 403, 'Step-up challenge expired', {
        challengeId,
        action,
        payloadHash: normalizedHash,
        outcome: OUTCOMES.EXPIRED,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    }

    if (record.action !== action || record.payloadHash !== normalizedHash) {
      return this._fail(
        FAILURE_CODES.MISMATCHED_CHALLENGE,
        403,
        'Step-up challenge does not match action or payload',
        {
          challengeId,
          action,
          payloadHash: normalizedHash,
          outcome: OUTCOMES.MISMATCHED,
          expiresAt: new Date(record.expiresAt).toISOString(),
        }
      );
    }

    if (context.userId && record.userId !== context.userId) {
      return this._fail(FAILURE_CODES.FORBIDDEN, 403, 'Step-up challenge belongs to another user', {
        challengeId,
        action,
        payloadHash: normalizedHash,
        outcome: OUTCOMES.FORBIDDEN,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    }

    this._audit({
      event: 'step_up.verified',
      challengeId,
      userId: record.userId,
      action,
      payloadHash: normalizedHash,
      outcome: OUTCOMES.SUCCESS,
      expiresAt: new Date(record.expiresAt).toISOString(),
    });

    return { ok: true, record };
  }

  _fail(code, status, message, audit) {
    this._audit({
      event: 'step_up.failed',
      code,
      ...audit,
    });
    return { ok: false, code, status, message };
  }
}

class StepUpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'StepUpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Build Express middleware that enforces step-up verification for `action`.
 *
 * @param {string} action - logical action name (e.g. 'contract.upgrade')
 * @param {function} payloadHashResolver - (req) => string | Promise<string>
 * @param {object} [options]
 * @param {StepUpService} [options.service] - service instance (required)
 * @param {string} [options.header] - header carrying the challenge id
 * @param {function} [options.getUserId] - (req) => string | undefined
 * @returns {function} Express middleware
 */
function requireStepUp(action, payloadHashResolver, options = {}) {
  if (!isNonEmptyString(action)) {
    throw new Error('requireStepUp: action is required');
  }
  if (typeof payloadHashResolver !== 'function') {
    throw new Error('requireStepUp: payloadHashResolver must be a function');
  }
  const service = options.service;
  if (!service || typeof service.verifyAndConsume !== 'function') {
    throw new Error('requireStepUp: options.service (StepUpService) is required');
  }
  const header = (options.header || DEFAULT_HEADER).toLowerCase();
  const getUserId =
    typeof options.getUserId === 'function'
      ? options.getUserId
      : (req) => (req.user && (req.user.id || req.user.userId)) || undefined;

  return async function stepUpMiddleware(req, res, next) {
    let payloadHash;
    try {
      payloadHash = await payloadHashResolver(req);
    } catch (err) {
      return sendFailure(res, 400, FAILURE_CODES.INVALID_PAYLOAD_HASH, 'Unable to resolve payload hash');
    }

    if (!isHexHash(payloadHash)) {
      return sendFailure(
        res,
        400,
        FAILURE_CODES.INVALID_PAYLOAD_HASH,
        'payloadHash must be a hex SHA-256 digest'
      );
    }

    const challengeId = req.get ? req.get(header) : req.headers && req.headers[header];

    if (!isNonEmptyString(challengeId)) {
      // Record audit evidence even when the challenge is missing.
      service._audit({
        event: 'step_up.failed',
        code: FAILURE_CODES.MISSING_CHALLENGE,
        challengeId: null,
        action,
        payloadHash: payloadHash.toLowerCase(),
        outcome: OUTCOMES.MISSING,
      });
      return sendFailure(
        res,
        401,
        FAILURE_CODES.MISSING_CHALLENGE,
        'Step-up challenge is required'
      );
    }

    const userId = getUserId(req);
    if (!userId) {
      service._audit({
        event: 'step_up.failed',
        code: FAILURE_CODES.UNAUTHENTICATED,
        challengeId,
        action,
        payloadHash: payloadHash.toLowerCase(),
        outcome: OUTCOMES.UNAUTHENTICATED,
      });
      return sendFailure(res, 401, FAILURE_CODES.UNAUTHENTICATED, 'Authentication required');
    }

    const result = service.verifyAndConsume(challengeId, action, payloadHash, { userId });
    if (!result.ok) {
      return sendFailure(res, result.status, result.code, result.message);
    }

    // Attach evidence for downstream handlers / logging.
    req.stepUp = {
      challengeId,
      action,
      payloadHash: payloadHash.toLowerCase(),
      userId,
      expiresAt: new Date(result.record.expiresAt).toISOString(),
    };

    return next();
  };
}

function sendFailure(res, status, code, message) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json({ error: { code, message } });
  }
  // Fallback for non-Express response objects.
  res.statusCode = status;
  if (typeof res.end === 'function') {
    res.end(JSON.stringify({ error: { code, message } }));
  }
  return undefined;
}

module.exports = {
  StepUpService,
  StepUpError,
  InMemoryChallengeStore,
  NoopAuditSink,
  requireStepUp,
  hashPayload,
  stableStringify,
  FAILURE_CODES,
  OUTCOMES,
  DEFAULT_TTL_MS,
  DEFAULT_HEADER,
};