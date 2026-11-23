'use strict';

const { z } = require('zod');
const { sanitized } = require('./index');
const { parseAmount, AmountError } = require('../lib/amount');

const MAX_METADATA_BYTES = 2 * 1024;

// Stellar amounts support at most 7 fractional digits (stroop precision).
const MAX_AMOUNT_DECIMALS = 7;
const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

const metadataSchema = z
  .record(z.string(), z.json())
  .refine(
    (metadata) => Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_METADATA_BYTES,
    { message: 'metadata must not exceed 2KB' },
  );

const amountSchema = z
  .string({ error: 'amount is required' })
  .trim()
  .min(1)
  .regex(AMOUNT_PATTERN, {
    message: `amount must be a decimal string with at most ${MAX_AMOUNT_DECIMALS} fractional digits`,
  })
  .refine((value) => Number(value) > 0, {
    message: 'amount must be greater than zero',
  });

const paymentIntentSchema = z.object({
  // Free-text identifier supplied by the caller — sanitize before storage.
  external_id: sanitized(z.string().trim()).optional(),
  // Stellar addresses and amounts are structurally constrained by the handler
  // (StrKey / numeric checks), so they don't need HTML sanitization here.
  from: z.string({ error: 'from address is required' }).trim().min(1),
  to: z.string({ error: 'to address is required' }).trim().min(1),
  amount: amountSchema,
  asset: z.string().trim().optional(),
  // Memo fields are free text that may be stored and rendered in the dashboard.
  memo_type: sanitized(z.string().trim()).optional(),
  memo: sanitized(z.string().trim()).optional(),
  metadata: metadataSchema.optional(),
});

/**
 * Bulk item schema: a payment intent plus a stable per-item external
 * identifier and an explicit ordering index used to preserve request order.
 */
const bulkPaymentItemSchema = paymentIntentSchema.extend({
  external_id: sanitized(z.string().trim()).min(1, { message: 'external_id is required for bulk items' }),
  index: z.number({ error: 'index is required' }).int().nonnegative(),
});

const bulkPaymentSchema = z.array(bulkPaymentItemSchema).min(1).max(1000);

/**
 * Bulk request envelope: carries a stable batch identifier so retries with
 * the same batch_id are idempotent, plus the ordered items.
 */
const bulkPaymentRequestSchema = z.object({
  batch_id: sanitized(z.string().trim()).min(1, { message: 'batch_id is required' }),
  items: bulkPaymentSchema,
});

module.exports = {
  paymentIntentSchema,
  bulkPaymentItemSchema,
  bulkPaymentSchema,
  bulkPaymentRequestSchema,
  amountSchema,
  metadataSchema,
  amountSchema,
  MAX_METADATA_BYTES,
  MAX_AMOUNT_DECIMALS,
  AMOUNT_PATTERN,
};