const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');

const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { accountPaymentsQuerySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { fetchPaymentsForAccount } = require('../../services/stellarService');

const router = express.Router();

// Stellar amounts are expressed in stroops (7 decimal places).
const STELLAR_ASSET_PRECISION = 7;

/**
 * Normalize a Horizon amount string to an exact decimal string at the given
 * precision. Returns null when the value is missing or not a finite number.
 */
function toExactAmount(value, precision = STELLAR_ASSET_PRECISION) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric.toFixed(precision);
}

/**
 * Normalize a Horizon payment record so monetary fields are exact decimal
 * strings and transaction identity carries the Stellar network.
 */
function normalizePaymentRecord(record, network) {
  if (!record || typeof record !== 'object') return record;

  const normalized = { ...record };

  if ('amount' in normalized) {
    normalized.amount = toExactAmount(normalized.amount);
  }

  if (normalized.source_amount !== undefined && normalized.source_amount !== null) {
    normalized.source_amount = toExactAmount(normalized.source_amount);
  }

  if (normalized.transaction && typeof normalized.transaction === 'object') {
    normalized.transaction = {
      ...normalized.transaction,
      network: normalized.transaction.network || network,
    };
  }

  if (normalized.transaction_hash) {
    normalized.transaction_identity = {
      network: network || null,
      transaction_hash: normalized.transaction_hash,
    };
  }

  return normalized;
}


/**
 * @openapi
 * /accounts/:account/payments:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /accounts/:account/payments
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/accounts/:account/payments', validateSchema({ query: accountPaymentsQuerySchema }), asyncHandler(async (req, res, next) => {
  const { account } = req.params;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    return next(new ApiError('INVALID_INPUT', 'Invalid Stellar account'));
  }

  const { limit, cursor, order } = req.query;
  const network = req.query.network || req.app?.locals?.stellarNetwork || process.env.STELLAR_NETWORK || 'public';

  try {
    const page = await fetchPaymentsForAccount({ address: account, limit, cursor, order });

    const rawRecords = page._embedded?.records || [];
    const records = rawRecords.map((record) => normalizePaymentRecord(record, network));
    const next = page._links?.next?.href || null;
    const prev = page._links?.prev?.href || null;

    return res.json({ records, next, prev, limit, order, network });
  } catch (err) {
    if (err?.code === 'EOPENBREAKER') {
      return next(new ApiError('SERVICE_UNAVAILABLE', 'Stellar Horizon is temporarily unavailable; please try again later'));
    }
    if (err && err.response && err.response.status === 404) {
      return next(new ApiError('NOT_FOUND', 'Account not found'));
    }
    return next(new ApiError('UPSTREAM_ERROR', 'Failed to fetch payments from Horizon', { cause: err }));
  }
}));

module.exports = router;
