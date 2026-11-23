import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

const stellarAddress = z
  .string()
  .min(1, 'Destination address is required')
  .refine((addr) => StrKey.isValidEd25519PublicKey(addr), 'Invalid Stellar address');

// Canonical payment lifecycle statuses. These are the only values that may be
// persisted; legacy values are mapped to these via `normalizePaymentStatus`.
export const PAYMENT_STATUSES = Object.freeze(['pending', 'submitted', 'confirmed', 'failed']);

// Allowed payment lifecycle transitions. A status may only move to one of the
// statuses listed here; anything else is rejected as a disallowed write.
export const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['submitted', 'failed']),
  submitted: Object.freeze(['confirmed', 'failed']),
  confirmed: Object.freeze([]),
  failed: Object.freeze([]),
});

// Legacy persisted values mapped to their canonical equivalents.
const LEGACY_PAYMENT_STATUS_MAP = Object.freeze({
  created: 'pending',
  queued: 'pending',
  processing: 'submitted',
  sent: 'submitted',
  success: 'confirmed',
  succeeded: 'confirmed',
  complete: 'confirmed',
  completed: 'confirmed',
  error: 'failed',
  rejected: 'failed',
});

/**
 * Normalize a persisted payment status to its canonical value.
 * Returns `undefined` for unknown values so callers can reject the write.
 */
export function normalizePaymentStatus(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (PAYMENT_STATUSES.includes(normalized)) return normalized;
  return LEGACY_PAYMENT_STATUS_MAP[normalized];
}

/**
 * Assert that a payment may transition from `from` to `to`.
 * Throws a descriptive error for unknown or disallowed transitions.
 */
export function assertPaymentTransition(from, to) {
  const fromStatus = normalizePaymentStatus(from);
  const toStatus = normalizePaymentStatus(to);
  if (!fromStatus) throw new Error(`Unknown payment status: ${String(from)}`);
  if (!toStatus) throw new Error(`Unknown payment status: ${String(to)}`);
  if (fromStatus === toStatus) return toStatus;
  const allowed = PAYMENT_STATUS_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Disallowed payment transition: ${fromStatus} -> ${toStatus}`);
  }
  return toStatus;
}

// Canonical webhook lifecycle statuses and their allowed transitions.
export const WEBHOOK_STATUSES = Object.freeze(['received', 'processing', 'delivered', 'failed']);

export const WEBHOOK_STATUS_TRANSITIONS = Object.freeze({
  received: Object.freeze(['processing', 'failed']),
  processing: Object.freeze(['delivered', 'failed']),
  delivered: Object.freeze([]),
  failed: Object.freeze([]),
});

const LEGACY_WEBHOOK_STATUS_MAP = Object.freeze({
  pending: 'received',
  queued: 'received',
  in_progress: 'processing',
  retrying: 'processing',
  success: 'delivered',
  succeeded: 'delivered',
  complete: 'delivered',
  completed: 'delivered',
  error: 'failed',
  dead: 'failed',
});

/**
 * Normalize a persisted webhook status to its canonical value.
 * Returns `undefined` for unknown values so callers can reject the write.
 */
export function normalizeWebhookStatus(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (WEBHOOK_STATUSES.includes(normalized)) return normalized;
  return LEGACY_WEBHOOK_STATUS_MAP[normalized];
}

/**
 * Assert that a webhook may transition from `from` to `to`.
 * Throws a descriptive error for unknown or disallowed transitions.
 */
export function assertWebhookTransition(from, to) {
  const fromStatus = normalizeWebhookStatus(from);
  const toStatus = normalizeWebhookStatus(to);
  if (!fromStatus) throw new Error(`Unknown webhook status: ${String(from)}`);
  if (!toStatus) throw new Error(`Unknown webhook status: ${String(to)}`);
  if (fromStatus === toStatus) return toStatus;
  const allowed = WEBHOOK_STATUS_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Disallowed webhook transition: ${fromStatus} -> ${toStatus}`);
  }
  return toStatus;
}

const paymentStatusSchema = z
  .string()
  .transform((val, ctx) => {
    const normalized = normalizePaymentStatus(val);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown payment status: ${val}`,
      });
      return z.NEVER;
    }
    return normalized;
  });

export const paymentSchema = z.object({
  destinationAddress: stellarAddress,
  amount: z
    .string()
    .min(1, 'Amount is required')
    .refine((val) => !Number.isNaN(Number(val)) && Number(val) > 0, 'Amount must be a positive number'),
  asset: z.string().min(1, 'Asset is required'),
  memo: z.string().max(28, 'Memo must be 28 characters or fewer').optional(),
});

// Runtime schema for payment API responses returned by the dashboard client.
// Mirrors the PaymentResponse shape in docs/openapi.json so contract drift is
// caught at runtime rather than surfacing as undefined fields in the UI.
export const paymentResponseSchema = z.object({
  id: z.string().min(1, 'Payment id is required'),
  status: paymentStatusSchema,
  destinationAddress: stellarAddress,
  amount: z
    .string()
    .min(1, 'Amount is required')
    .refine((val) => !Number.isNaN(Number(val)) && Number(val) > 0, 'Amount must be a positive number'),
  asset: z.string().min(1, 'Asset is required'),
  memo: z.string().max(28, 'Memo must be 28 characters or fewer').optional(),
  transactionHash: z.string().min(1).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});

export const paymentListResponseSchema = z.object({
  items: z.array(paymentResponseSchema),
  cursor: z.string().optional(),
});

export default paymentSchema;
