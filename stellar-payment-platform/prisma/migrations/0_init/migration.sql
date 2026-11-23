-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- =============================================================================
-- Migration: exact_money_and_network
-- =============================================================================
--
-- This migration is written as an expand / backfill / contract sequence so it
-- can be audited and recovered in stages.
--
-- -----------------------------------------------------------------------------
-- #384 — Exact monetary units (expand / backfill / contract)
-- -----------------------------------------------------------------------------
-- Monetary columns previously stored as floating point ("amount", "fee") are
-- replaced with exact integer minor units ("amount_units", "fee_units") plus an
-- explicit per-row "asset_precision".
--
-- ROUNDING RULE (documented policy):
--   * Values are converted to minor units by multiplying by 10^asset_precision
--     and rounding HALF-UP to the nearest integer (PostgreSQL ROUND(numeric, 0)
--     rounds half away from zero, i.e. half-up for positive values).
--   * The default asset precision is 7, matching Stellar's 7-decimal precision
--     for issued assets. Rows are backfilled using the per-row asset_precision
--     (defaulted to 7) so future assets with different precision remain exact.
--   * "fee_units" defaults to 0 when the legacy "fee" value is NULL.
--
-- RECOVERY:
--   * The legacy "amount" and "fee" columns are dropped only after the backfill
--     completes within this same transactional migration. If the migration is
--     rolled back, the original columns are restored by the transaction.
--   * To recover the human-readable value: amount = amount_units / 10^asset_precision.
--
-- -----------------------------------------------------------------------------
-- #385 — Unique ledger transaction identity per Stellar network
-- -----------------------------------------------------------------------------
-- Ledger transactions are now identified by (network, hash) rather than hash
-- alone, so the same transaction hash can legitimately exist on distinct
-- networks (e.g. testnet and pubnet).
--
-- NETWORK BACKFILL POLICY (documented policy):
--   * Existing rows predate network identity and are backfilled with the
--     explicit default network 'testnet'. This is the documented policy for
--     historical ingestion, which only ever targeted testnet.
--   * The "network" column is NOT NULL with a DEFAULT 'testnet' so ingestion
--     upserts that do not specify a network remain deterministic.
--
-- RECOVERY:
--   * The previous unique index on "hash" is dropped and replaced by a unique
--     composite index on ("network", "hash"). Rolling back this migration
--     restores the single-column unique index (only valid if no duplicate
--     hashes across networks exist).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- #384: EXPAND — add exact-unit columns
-- -----------------------------------------------------------------------------
ALTER TABLE "payments" ADD COLUMN "amount_units" BIGINT;
ALTER TABLE "payments" ADD COLUMN "fee_units" BIGINT DEFAULT 0;
ALTER TABLE "payments" ADD COLUMN "asset_precision" SMALLINT DEFAULT 7;

-- -----------------------------------------------------------------------------
-- #384: BACKFILL — convert legacy floating point to exact minor units
--   half-up rounding to the row's asset precision (default 7 for Stellar)
-- -----------------------------------------------------------------------------
UPDATE "payments"
SET "amount_units" = ROUND("amount"::numeric * POWER(10::numeric, COALESCE("asset_precision", 7)), 0)
WHERE "amount" IS NOT NULL;

UPDATE "payments"
SET "fee_units" = ROUND("fee"::numeric * POWER(10::numeric, COALESCE("asset_precision", 7)), 0)
WHERE "fee" IS NOT NULL;

-- Normalize NULL fee to the documented default of 0 minor units.
UPDATE "payments"
SET "fee_units" = 0
WHERE "fee_units" IS NULL;

-- -----------------------------------------------------------------------------
-- #384: CONTRACT — enforce exact-unit invariants and drop legacy columns
-- -----------------------------------------------------------------------------
ALTER TABLE "payments" ALTER COLUMN "amount_units" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "fee_units" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "fee_units" SET DEFAULT 0;
ALTER TABLE "payments" ALTER COLUMN "asset_precision" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "asset_precision" SET DEFAULT 7;

ALTER TABLE "payments" DROP COLUMN "amount";
ALTER TABLE "payments" DROP COLUMN "fee";

-- -----------------------------------------------------------------------------
-- #385: EXPAND — add network identity with explicit default policy
-- -----------------------------------------------------------------------------
ALTER TABLE "transactions" ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';

-- -----------------------------------------------------------------------------
-- #385: BACKFILL — historical rows default to the documented 'testnet' policy
-- -----------------------------------------------------------------------------
UPDATE "transactions"
SET "network" = 'testnet'
WHERE "network" IS NULL OR "network" = '';

-- -----------------------------------------------------------------------------
-- #385: CONTRACT — replace hash-only uniqueness with (network, hash)
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS "transactions_hash_key";

CREATE UNIQUE INDEX "transactions_network_hash_key" ON "transactions"("network", "hash");
CREATE INDEX "transactions_network_idx" ON "transactions"("network");

-- CreateTable
CREATE TABLE "username_registry" (
    "username" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flagged_at" TIMESTAMP(3),

    CONSTRAINT "username_registry_pkey" PRIMARY KEY ("username")
);

-- CreateIndex
CREATE UNIQUE INDEX "username_registry_address_key" ON "username_registry"("address");

-- CreateIndex
CREATE INDEX "username_registry_username_idx" ON "username_registry"("username");