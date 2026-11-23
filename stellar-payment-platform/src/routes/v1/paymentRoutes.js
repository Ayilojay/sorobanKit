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
const { normalizeAmount, AmountError } = require('../../utils/amount');

// Stellar assets are denominated in 7 decimal places (stroops).
const STELLAR_ASSET_PRECISION = 7;

// Resolve the network the payment intent is bound to. Falls back to the
// configured default so transaction identity always includes a network.
const resolveNetwork = (intent) =>
  intent.network || process.env.STELLAR_NETWORK || 'testnet';

module.exports = (redisClient) => {
  const router = express.Router();
  
  router.use(idempotencyMiddleware(redisClient));

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

    return res.status(201).json({ ok: true, count: created.length, data: created.map((c) => ({ id: c.id, external_id: c.externalId })) });
  } catch (error) {
    logger.error('Bulk payment registration failed:', error);
    const dbErr = new Error('Failed to register payment intents');
    dbErr.statusCode = 500;
    return next(dbErr);
  }
}));

  return router;
};
