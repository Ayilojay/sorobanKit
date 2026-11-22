import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

const stellarAddress = z
  .string()
  .min(1, 'Destination address is required')
  .refine((addr) => StrKey.isValidEd25519PublicKey(addr), 'Invalid Stellar address');

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
  status: z.enum(['pending', 'submitted', 'confirmed', 'failed']),
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
