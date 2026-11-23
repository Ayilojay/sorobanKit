'use strict';

const { z } = require('zod');
const { sanitized } = require('./common');

/** GET /transactions/export query. */
const exportQuerySchema = z
  .object({
    address: z.string({ error: 'address is required' }).trim().min(1, 'address is required'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .loose();

/** POST /admin/block */
const adminBlockBodySchema = z
  .object({
    address: z.string({ error: 'Missing or invalid address' }).trim().min(1, 'Missing or invalid address'),
  })
  .loose();

/**
 * GET /admin/export query.
 *
 * - `format`    csv (default) | json
 * - `startDate` optional ISO date string (YYYY-MM-DD), inclusive lower bound
 * - `endDate`   optional ISO date string (YYYY-MM-DD), inclusive upper bound
 */
const adminExportQuerySchema = z
  .object({
    format: z.enum(['csv', 'json']).catch('csv'),
    limit: z.string().regex(/^[0-9]+$/, 'limit must be a positive integer')
      .transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).optional(),
    startDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
      .optional(),
    endDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD')
      .optional(),
  })
  .loose()
  .refine(
    (value) => {
      if (value.startDate && value.endDate) {
        return new Date(value.startDate) <= new Date(value.endDate);
      }
      return true;
    },
    { error: 'startDate must be on or before endDate', path: ['startDate'] },
  );

/**
 * GET /admin/stats/routing query.
 *
 * - `startDate` optional ISO date string (YYYY-MM-DD), inclusive lower bound
 * - `endDate`   optional ISO date string (YYYY-MM-DD), inclusive upper bound
 * - `groupBy`   optional grouping interval ('day' | 'week' | 'month'), defaults to 'day'
 * - `interval`  optional alias for groupBy ('day' | 'week' | 'month')
 * - `assetCode` optional Stellar asset code filter
 */
const adminRoutingStatsQuerySchema = z
  .object({
    startDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
      .optional(),
    endDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD')
      .optional(),
    groupBy: z.enum(['day', 'week', 'month']).optional().default('day'),
    interval: z.enum(['day', 'week', 'month']).optional(),
    assetCode: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,12}$/, 'assetCode must be 1-12 uppercase letters or digits')
      .optional(),
  })
  .loose()
  .refine(
    (value) => {
      if (value.startDate && value.endDate) {
        return new Date(value.startDate) <= new Date(value.endDate);
      }
      return true;
    },
    { error: 'startDate must be on or before endDate', path: ['startDate'] },
  );
/** POST /auth/api-keys - generate a new API key */
const createApiKeyBodySchema = z
  .object({
    name: sanitized(
      z
        .string({ error: 'name is required' })
        .trim()
        .min(1, 'name cannot be empty')
        .max(100, 'name must be 100 characters or less'),
    ),
    owner_id: sanitized(
      z
        .string({ error: 'owner_id is required' })
        .trim()
        .min(1, 'owner_id cannot be empty')
        .max(256, 'owner_id must be 256 characters or less'),
    ),
    scopes: z
      .string()
      .trim()
      .optional()
      .default('read,write')
      .refine(
        (val) => val.split(',').every((s) => ['read', 'write', 'admin'].includes(s.trim())),
        { error: 'scopes must be a comma-separated list of: read, write, admin' },
      ),
    expires_in_hours: z
      .number({ error: 'expires_in_hours must be a number' })
      .int()
      .min(1, 'expires_in_hours must be at least 1')
      .max(8760, 'expires_in_hours must be at most 8760 (1 year)')
      .optional(),
  })
  .loose();

/** POST /auth/api-keys/:id/revoke - revoke an API key */
const revokeApiKeyBodySchema = z
  .object({
    revoked_by: sanitized(
      z
        .string({ error: 'revoked_by is required' })
        .trim()
        .min(1, 'revoked_by cannot be empty')
        .max(256, 'revoked_by must be 256 characters or less'),
    ),
  })
  .loose();

/**
 * POST /auth/api-keys/:id/rotate - rotate an API key with a bounded overlap window.
 *
 * The predecessor key remains valid until `overlap_hours` elapse (or until it is
 * explicitly revoked). `grace_period_hours` is retained as a backwards-compatible
 * alias for `overlap_hours`; when both are supplied they must agree.
 */
const rotateApiKeyBodySchema = z
  .object({
    name: sanitized(
      z
        .string()
        .trim()
        .min(1, 'name cannot be empty')
        .max(100, 'name must be 100 characters or less'),
    ).optional(),
    overlap_hours: z
      .number({ error: 'overlap_hours must be a number' })
      .int('overlap_hours must be an integer')
      .min(0, 'overlap_hours must be at least 0')
      .max(24, 'overlap_hours must be at most 24')
      .optional(),
    grace_period_hours: z
      .number({ error: 'grace_period_hours must be a number' })
      .int('grace_period_hours must be an integer')
      .min(0, 'grace_period_hours must be at least 0')
      .max(24, 'grace_period_hours must be at most 24')
      .optional(),
    revoked_by: sanitized(
      z
        .string()
        .trim()
        .min(1, 'revoked_by cannot be empty')
        .max(256, 'revoked_by must be 256 characters or less'),
    ).optional(),
    rotated_by: sanitized(
      z
        .string()
        .trim()
        .min(1, 'rotated_by cannot be empty')
        .max(256, 'rotated_by must be 256 characters or less'),
    ).optional(),
  })
  .loose()
  .refine(
    (value) =>
      value.overlap_hours === undefined ||
      value.grace_period_hours === undefined ||
      value.overlap_hours === value.grace_period_hours,
    { error: 'overlap_hours and grace_period_hours must agree when both are provided', path: ['overlap_hours'] },
  )
  .transform((value) => ({
    ...value,
    overlap_hours: value.overlap_hours ?? value.grace_period_hours ?? 1,
  }));

/** Step-up protected administrative actions. */
const STEP_UP_ACTIONS = ['contract_upgrade', 'treasury_change', 'bulk_export'];

/** Payload hash: lowercase hex SHA-256 digest. */
const payloadHashSchema = z
  .string({ error: 'payload_hash is required' })
  .trim()
  .regex(/^[a-f0-9]{64}$/, 'payload_hash must be a 64-character lowercase hex SHA-256 digest');

/**
 * POST /admin/step-up/challenges - issue a short-lived, single-use step-up challenge.
 *
 * Either `payload_hash` (precomputed digest) or `payload` (raw JSON body that the
 * server hashes) must be supplied so the challenge is bound to the exact action.
 */
const stepUpChallengeBodySchema = z
  .object({
    action: z.enum(STEP_UP_ACTIONS, { error: `action must be one of: ${STEP_UP_ACTIONS.join(', ')}` }),
    payload_hash: payloadHashSchema.optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    reason: sanitized(
      z
        .string()
        .trim()
        .min(1, 'reason cannot be empty')
        .max(500, 'reason must be 500 characters or less'),
    ).optional(),
  })
  .loose()
  .refine((value) => value.payload_hash !== undefined || value.payload !== undefined, {
    error: 'either payload_hash or payload is required',
    path: ['payload_hash'],
  });

/** POST /admin/step-up/confirm - confirm a step-up challenge. */
const stepUpConfirmBodySchema = z
  .object({
    challenge_id: sanitized(
      z
        .string({ error: 'challenge_id is required' })
        .trim()
        .min(1, 'challenge_id cannot be empty')
        .max(128, 'challenge_id must be 128 characters or less'),
    ),
    payload_hash: payloadHashSchema,
    action: z.enum(STEP_UP_ACTIONS, { error: `action must be one of: ${STEP_UP_ACTIONS.join(', ')}` }).optional(),
  })
  .loose();

/** POST /admin/contracts/upgrade - contract upgrade (step-up protected). */
const contractUpgradeBodySchema = z
  .object({
    contract_id: sanitized(
      z
        .string({ error: 'contract_id is required' })
        .trim()
        .min(1, 'contract_id cannot be empty')
        .max(128, 'contract_id must be 128 characters or less'),
    ),
    wasm_hash: z
      .string({ error: 'wasm_hash is required' })
      .trim()
      .regex(/^[a-f0-9]{64}$/, 'wasm_hash must be a 64-character lowercase hex SHA-256 digest'),
    step_up_challenge_id: sanitized(
      z
        .string({ error: 'step_up_challenge_id is required' })
        .trim()
        .min(1, 'step_up_challenge_id cannot be empty')
        .max(128, 'step_up_challenge_id must be 128 characters or less'),
    ),
    payload_hash: payloadHashSchema,
    reason: sanitized(
      z
        .string()
        .trim()
        .min(1, 'reason cannot be empty')
        .max(500, 'reason must be 500 characters or less'),
    ).optional(),
  })
  .loose();

module.exports = {
  exportQuerySchema,
  adminBlockBodySchema,
  adminExportQuerySchema,
  adminRoutingStatsQuerySchema,
  createApiKeyBodySchema,
  revokeApiKeyBodySchema,
  rotateApiKeyBodySchema,
  STEP_UP_ACTIONS,
  payloadHashSchema,
  stepUpChallengeBodySchema,
  stepUpConfirmBodySchema,
  contractUpgradeBodySchema,
};
