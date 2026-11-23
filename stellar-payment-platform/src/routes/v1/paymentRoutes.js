const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../../prismaClient');
const { validateSchema } = require('../../middleware/validateSchema');
const { requireJson } = require('../../middleware/requireJson');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { paymentIntentSchema, bulkPaymentSchema } = require('../../schemas/paymentSchema');
const { StrKey } = require('@stellar/stellar-sdk');
const { logger } = require('../../logger');
const { idempotencyMiddleware } = require('../../../middleware/idempotency');
const { updatePaymentIntentStatus } = require('../../services/paymentIntentStateMachine');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

// ── SSE configuration ────────────────────────────────────────────────────────
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);
const SSE_MAX_CONNECTIONS_PER_USER = Number(process.env.SSE_MAX_CONNECTIONS_PER_USER || 5);
const SSE_MAX_CONNECTIONS_GLOBAL = Number(process.env.SSE_MAX_CONNECTIONS_GLOBAL || 500);
const SSE_MAX_LIFETIME_MS = Number(process.env.SSE_MAX_LIFETIME_MS || 30 * 60 * 1000);

// In-process event bus for payment status updates. Exposed so other modules
// (e.g. the state machine) can publish updates via `paymentEvents`.
const paymentEvents = new EventEmitter();
paymentEvents.setMaxListeners(0);

// Global connection accounting.
let globalConnections = 0;
const connectionsByUser = new Map();

function acquireConnection(userId) {
  if (globalConnections >= SSE_MAX_CONNECTIONS_GLOBAL) return false;
  const current = connectionsByUser.get(userId) || 0;
  if (current >= SSE_MAX_CONNECTIONS_PER_USER) return false;
  globalConnections += 1;
  connectionsByUser.set(userId, current + 1);
  return true;
}

function releaseConnection(userId) {
  globalConnections = Math.max(0, globalConnections - 1);
  const current = connectionsByUser.get(userId) || 0;
  if (current <= 1) connectionsByUser.delete(userId);
  else connectionsByUser.set(userId, current - 1);
}

module.exports = (redisClient) => {
  const router = express.Router();

  // ── Idempotency protection for payment intent creation (POST /payments/bulk).
  // Duplicate submissions within 24h return the originally created intents. ──
  router.use(idempotencyMiddleware(redisClient));

  // POST /payments/bulk

/**
 * @openapi
 * /payments/bulk:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /payments/bulk
 *     responses:
 *       200:
 *         description: Success
 */
  router.post('/payments/bulk', requireJson, validateSchema({ body: bulkPaymentSchema }), asyncHandler(async (req, res, next) => {
    const intents = req.body;

    // ── Phase 1: validate every item before touching the database
    // (all-or-nothing semantics). ──
    const validationErrors = [];
    for (let idx = 0; idx < intents.length; idx += 1) {
      const intent = intents[idx];
      if (!StrKey.isValidEd25519PublicKey(intent.from)) {
        validationErrors.push({ index: idx, field: 'from', message: 'Invalid Stellar public key' });
      }
      if (!StrKey.isValidEd25519PublicKey(intent.to)) {
        validationErrors.push({ index: idx, field: 'to', message: 'Invalid Stellar public key' });
      }
    }
    if (validationErrors.length > 0) {
      const err = new Error('Bulk payment validation failed');
      err.statusCode = 400;
      err.details = validationErrors;
      throw err;
    }

    // ── Phase 2: assign stable identifiers. The batchId is generated once per
    // request; itemIds are deterministic per (batchId, index) so retries with
    // the same external IDs resolve to the same records. ──
    const batchId = randomUUID();
    const items = intents.map((intent, index) => ({
      index,
      itemId: `${batchId}:${index}`,
      externalId: intent.external_id,
      from: intent.from,
      to: intent.to,
      amount: intent.amount,
      asset: intent.asset,
      memoType: intent.memo_type,
      memo: intent.memo,
      metadata: intent.metadata,
    }));

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Resolve any pre-existing records for repeated external IDs so retries
        // are safe and idempotent.
        const externalIds = items
          .map((item) => item.externalId)
          .filter((value) => value !== undefined && value !== null);

        const existing = externalIds.length > 0
          ? await tx.paymentIntent.findMany({ where: { externalId: { in: externalIds } } })
          : [];
        const existingByExternalId = new Map(existing.map((row) => [row.externalId, row]));

        const created = [];
        for (const item of items) {
          if (item.externalId && existingByExternalId.has(item.externalId)) {
            created.push(existingByExternalId.get(item.externalId));
            continue;
          }
          const row = await tx.paymentIntent.create({
            data: {
              externalId: item.externalId,
              batchId,
              itemId: item.itemId,
              from: item.from,
              to: item.to,
              amount: item.amount,
              asset: item.asset,
              memoType: item.memoType,
              memo: item.memo,
              metadata: item.metadata,
            },
          });
          created.push(row);
        }
        return created;
      });

      return res.status(201).json({
        ok: true,
        batch_id: batchId,
        count: result.length,
        data: result.map((c) => ({ id: c.id, item_id: c.itemId, external_id: c.externalId })),
      });
    } catch (error) {
      logger.error('Bulk payment registration failed:', error);
      const dbErr = new Error('Failed to register payment intents');
      dbErr.statusCode = 500;
      return next(dbErr);
    }
  }));

  // GET /payments/:id/events — bounded server-sent event feed.
  router.get('/payments/:id/events', asyncHandler(async (req, res, next) => {
    const userId = req.user && (req.user.id || req.user.sub);
    if (!userId) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      return next(err);
    }

    const paymentId = req.params.id;
    const intent = await prisma.paymentIntent.findUnique({ where: { id: paymentId } });
    if (!intent) {
      const err = new Error('Payment intent not found');
      err.statusCode = 404;
      return next(err);
    }
    // Authorization: only the owner (or an admin) may stream updates.
    const isOwner = intent.from === userId || intent.metadata?.ownerId === userId;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      return next(err);
    }

    if (!acquireConnection(userId)) {
      const err = new Error('Too many concurrent event streams');
      err.statusCode = 429;
      return next(err);
    }

    // Reconnect cursor: resume after the last delivered event id.
    const lastEventId = Number(req.headers['last-event-id'] || req.query.lastEventId || 0) || 0;
    let eventCounter = lastEventId;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const writeEvent = (type, payload) => {
      eventCounter += 1;
      const body = {
        version: 1,
        id: eventCounter,
        type,
        payment_id: paymentId,
        timestamp: new Date().toISOString(),
        data: payload,
      };
      res.write(`id: ${eventCounter}\n`);
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(body)}\n\n`);
    };

    // Initial snapshot so clients can render immediately.
    writeEvent('snapshot', { status: intent.status, amount: intent.amount, asset: intent.asset });

    const onUpdate = (update) => {
      if (!update || update.paymentId !== paymentId) return;
      writeEvent('status', { status: update.status, previous_status: update.previousStatus });
    };
    paymentEvents.on('payment.status', onUpdate);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const lifetime = setTimeout(() => {
      cleanup();
      res.end();
    }, SSE_MAX_LIFETIME_MS);
    if (typeof lifetime.unref === 'function') lifetime.unref();

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      paymentEvents.removeListener('payment.status', onUpdate);
      releaseConnection(userId);
    }

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', (err) => {
      logger.warn('SSE stream error:', err && err.message);
      cleanup();
    });
  }));

  return router;
};

module.exports.paymentEvents = paymentEvents;
