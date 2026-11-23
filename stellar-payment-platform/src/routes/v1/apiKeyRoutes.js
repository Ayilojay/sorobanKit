const express = require('express');
const crypto = require('crypto');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const { createApiKeyBodySchema, revokeApiKeyBodySchema, rotateApiKeyBodySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../utils/jwt');
const {
  hashKey,
  validateApiKey,
  rotateApiKey,
  revokeApiKey,
  recordApiKeyAuditEvent,
} = require('../../services/apiKeyService');

module.exports = (redisClient) => {
  const router = express.Router();
  const { logger } = require('../../logger');
  const { prisma } = require('../../../prismaClient');

  const KEY_PREFIX = 'sk_live_';
  const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour default

  // Middleware: require a valid API key in the request
  const requireApiKey = asyncHandler(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const apiKey = req.headers['x-api-key'];

    let token = apiKey;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    if (!token) {
      return next(new ApiError('UNAUTHENTICATED', 'API key required. Provide via X-Api-Key header or Authorization: Bearer <key>'));
    }

    const record = await validateApiKey(token);
    if (!record) {
      return next(new ApiError('UNAUTHENTICATED', 'Invalid or expired API key'));
    }

    // Update lastUsedAt (fire-and-forget)
    prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

    req.apiKeyRecord = record;
    next();
  });

  // POST /auth/api-keys
  // Generate a new API key
  
/**
 * @openapi
 * /:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/', requireAuth, requireJson, validateSchema({ body: createApiKeyBodySchema }), asyncHandler(async (req, res, next) => {
    try {
      const { name, owner_id, scopes: scopesStr, expires_in_hours } = req.body;

      const scopes = scopesStr.split(',').map((s) => s.trim()).filter(Boolean);
      const rawKey = KEY_PREFIX + crypto.randomBytes(32).toString('hex');
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12);

      const expiresAt = expires_in_hours
        ? new Date(Date.now() + expires_in_hours * 60 * 60 * 1000)
        : null;

      const record = await prisma.apiKey.create({
        data: {
          name,
          ownerId: owner_id,
          keyHash,
          keyPrefix,
          scopes: scopes.length > 0 ? scopes : ['read', 'write'],
          expiresAt,
        },
      });

      logger.info(`[Correlation ID: ${req.correlationId}] API key created: ${record.id} for owner ${owner_id}`);

      return res.status(201).json({
        success: true,
        data: {
          id: record.id,
          name: record.name,
          key: rawKey,
          key_prefix: record.keyPrefix,
          owner_id: record.ownerId,
          scopes: record.scopes,
          expires_at: record.expiresAt,
          created_at: record.createdAt,
        },
        message: 'Save this API key securely. It will not be shown again.',
      });
    } catch (err) {
      return next(err);
    }
  }));

  // GET /auth/api-keys
  // List API keys for an owner
  
/**
 * @openapi
 * /:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/', requireAuth, asyncHandler(async (req, res, next) => {
    try {
      const ownerId = req.query.owner_id;
      if (!ownerId) {
        return next(new ApiError('INVALID_INPUT', 'owner_id query parameter is required'));
      }

      const keys = await prisma.apiKey.findMany({
        where: { ownerId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          ownerId: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          revokedBy: true,
          lastUsedAt: true,
          createdAt: true,
          predecessorId: true,
          successorId: true,
          overlapExpiresAt: true,
        },
      });

      // Raw key material is never persisted; only the prefix is ever exposed.
      const redacted = keys.map((k) => ({
        ...k,
        key: null,
        key_redacted: true,
      }));

      return res.json({ success: true, data: redacted });
    } catch (err) {
      return next(err);
    }
  }));

  // POST /auth/api-keys/:id/revoke
  // Revoke a specific API key
  
/**
 * @openapi
 * /:id/revoke:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /:id/revoke
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/:id/revoke', requireAuth, requireJson, validateSchema({ body: revokeApiKeyBodySchema }), asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;
      const { revoked_by } = req.body;

      const record = await prisma.apiKey.findUnique({ where: { id } });

      if (!record) {
        return next(new ApiError('NOT_FOUND', 'API key not found'));
      }

      if (record.revokedAt) {
        return next(new ApiError('CONFLICT', 'API key is already revoked'));
      }

      // Revocation is immediate: the key stops validating as soon as revokedAt is set.
      const updated = await revokeApiKey({
        id,
        revokedBy: revoked_by,
        correlationId: req.correlationId,
      });

      await recordApiKeyAuditEvent({
        apiKeyId: id,
        ownerId: updated.ownerId,
        action: 'revoke',
        actor: revoked_by,
        correlationId: req.correlationId,
        metadata: { revoked_at: updated.revokedAt },
      });

      logger.info(`[Correlation ID: ${req.correlationId}] API key revoked: ${id} by ${revoked_by}`);

      return res.json({
        success: true,
        data: {
          id: updated.id,
          name: updated.name,
          revoked_at: updated.revokedAt,
          revoked_by: updated.revokedBy,
        },
      });
    } catch (err) {
      return next(err);
    }
  }));

  // POST /auth/api-keys/:id/rotate
  // Rotate an API key: generate new key, revoke old one with grace period
  
/**
 * @openapi
 * /:id/rotate:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /:id/rotate
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/:id/rotate', requireAuth, requireJson, validateSchema({ body: rotateApiKeyBodySchema }), asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, grace_period_hours = 1 } = req.body;

      const oldRecord = await prisma.apiKey.findUnique({ where: { id } });

      if (!oldRecord) {
        return next(new ApiError('NOT_FOUND', 'API key not found'));
      }

      if (oldRecord.revokedAt) {
        return next(new ApiError('CONFLICT', 'API key is already revoked'));
      }

      // Issue a replacement key with a bounded overlap window. The old key keeps
      // validating until overlapExpiresAt, after which it is treated as revoked.
      const { newRecord, rawKey, overlapExpiresAt } = await rotateApiKey({
        id,
        name,
        gracePeriodHours: grace_period_hours,
        correlationId: req.correlationId,
      });

      await recordApiKeyAuditEvent({
        apiKeyId: newRecord.id,
        ownerId: newRecord.ownerId,
        action: 'rotate',
        actor: req.auth && req.auth.sub ? req.auth.sub : 'rotation',
        correlationId: req.correlationId,
        metadata: {
          predecessor_id: oldRecord.id,
          successor_id: newRecord.id,
          overlap_expires_at: overlapExpiresAt,
        },
      });

      logger.info(`[Correlation ID: ${req.correlationId}] API key rotated: ${id} -> ${newRecord.id} (overlap: ${grace_period_hours}h)`);

      // Raw key material is returned exactly once, here. It is never persisted
      // and is redacted on all subsequent reads.
      return res.status(201).json({
        success: true,
        data: {
          new_key: {
            id: newRecord.id,
            name: newRecord.name,
            key: rawKey,
            key_prefix: newRecord.keyPrefix,
            owner_id: newRecord.ownerId,
            scopes: newRecord.scopes,
            expires_at: newRecord.expiresAt,
            created_at: newRecord.createdAt,
            predecessor_id: oldRecord.id,
          },
          old_key: {
            id: oldRecord.id,
            revoked_at: newRecord.createdAt,
            overlap_expires_at: overlapExpiresAt,
            successor_id: newRecord.id,
          },
        },
        message: 'New API key created. The previous key remains valid until the overlap window expires. Save the new key securely; it will not be shown again.',
      });
    } catch (err) {
      return next(err);
    }
  }));

  return router;
};
