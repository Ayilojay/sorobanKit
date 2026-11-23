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
const {
  observeSubmissionToFinality,
  refreshOldestUnreconciledIntentAge,
} = require('../../services/ledgerLagMetrics');

module.exports = (redisClient) => {
  const router = express.Router();
  
  // ── Idempotency protection for payment intent creation (POST /payments/bulk).
  // Duplicate submissions within 24h (including from other browser tabs) return
  // the originally created intents. Registered once so the Idempotency-Key
  // header is honored exactly once per request. ──
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

  // Additional per-item validation that requires runtime logic
  const normalizedIntents = [];
  for (const idx in intents) {
    const intent = intents[idx];
    if (!StrKey.isValidEd25519PublicKey(intent.from)) {
      const err = new Error(`Invalid Stellar public key for 'from' at index ${idx}`);
      err.statusCode = 400;
      err.code = 'INVALID_INPUT';
      throw err;
    }
    if (!StrKey.isValidEd25519PublicKey(intent.to)) {
      const err = new Error(`Invalid Stellar public key for 'to' at index ${idx}`);
      err.statusCode = 400;
      err.code = 'INVALID_INPUT';
      throw err;
    }

    // Amounts are stored as exact decimal strings at asset precision. Values
    // with more fractional digits than the asset supports are rejected rather
    // than silently rounded.
    let amount;
    try {
      amount = normalizeAmount(intent.amount, { precision: STELLAR_ASSET_PRECISION });
    } catch (amountError) {
      if (amountError instanceof AmountError) {
        const err = new Error(`Invalid amount at index ${idx}: ${amountError.message}`);
        err.statusCode = 400;
        err.code = 'INVALID_INPUT';
        throw err;
      }
      throw amountError;
    }

    normalizedIntents.push({
      ...intent,
      amount,
      network: resolveNetwork(intent),
    });
  }

  try {
    const createOps = normalizedIntents.map((intent) => prisma.paymentIntent.create({
      data: {
        externalId: intent.external_id,
        from: intent.from,
        to: intent.to,
        amount: intent.amount,
        asset: intent.asset,
        network: intent.network,
        memoType: intent.memo_type,
        memo: intent.memo,
        metadata: intent.metadata,
      },
    }));

    const created = await prisma.$transaction(createOps);

    // Refresh the oldest-unreconciled-intent gauge per network after new
    // intents are registered. Labels are limited to network/operation/status.
    const networks = new Set(created.map((c) => c.network || 'unknown'));
    for (const network of networks) {
      await refreshOldestUnreconciledIntentAge(prisma, network);
    }

    return res.status(201).json({ ok: true, count: created.length, data: created.map((c) => ({ id: c.id, external_id: c.externalId })) });
  } catch (error) {
    logger.error('Bulk payment registration failed:', error);
    const dbErr = new Error('Failed to register payment intents');
    dbErr.statusCode = 500;
    return next(dbErr);
  }
}));

  // POST /payments/intents/:id/status
  // Transitions a payment intent and records submission-to-finality latency
  // when the intent reaches a terminal (finality) state.
  router.post('/payments/intents/:id/status', requireJson, asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!status || typeof status !== 'string') {
      const err = new Error('Missing required field: status');
      err.statusCode = 400;
      throw err;
    }

    try {
      const updated = await updatePaymentIntentStatus(prisma, id, status);

      if (updated && updated.submittedAt && updated.finalizedAt) {
        observeSubmissionToFinality({
          network: updated.network || 'unknown',
          operation: 'payment_intent',
          status: updated.status,
          submittedAt: updated.submittedAt,
          finalizedAt: updated.finalizedAt,
        });
      }

      if (updated) {
        await refreshOldestUnreconciledIntentAge(prisma, updated.network || 'unknown');
      }

      return res.status(200).json({ ok: true, data: { id: updated.id, status: updated.status } });
    } catch (error) {
      logger.error('Payment intent status transition failed:', error);
      const dbErr = new Error('Failed to update payment intent status');
      dbErr.statusCode = error.statusCode || 500;
      return next(dbErr);
    }
  }));

  return router;
};
