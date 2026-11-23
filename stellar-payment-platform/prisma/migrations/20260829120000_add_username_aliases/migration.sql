-- #386 — guarantee at most one primary federation username per address.
-- #387 — expand-contract migration: additive only, safe for rolling deploys.
--
-- Phase: EXPAND (additive)
--   * No columns are dropped or renamed.
--   * No existing rows are deleted.
--   * Old application versions (which do not know about the invariant) keep
--     working: they can still insert/update usernames, and the partial unique
--     index only rejects writes that would create a *second* active primary
--     for the same address — a state the application never intended to create.
--
-- Pre-migration repair (idempotent):
--   Legacy data may contain more than one active primary per address (e.g.
--   rows written before `is_primary` was introduced, or by concurrent writers
--   racing on the old code path). Before the index can be created we demote
--   every active primary except the newest one per address. "Newest" is
--   ordered by created_at DESC, username DESC so the choice is deterministic
--   even when timestamps collide.
--
--   The repair is idempotent: running it again on already-repaired data is a
--   no-op because each address has at most one active primary left, and the
--   window function ranks that single row as 1.
--
-- Soft-delete interaction:
--   The invariant applies only to *active* rows (`deleted_at IS NULL`). A
--   soft-deleted primary does not occupy the slot, so an address may have any
--   number of soft-deleted primaries plus at most one active primary. This
--   lets the application soft-delete a primary and promote a replacement in
--   the same transaction without violating the constraint.

-- ---------------------------------------------------------------------------
-- 1. Repair legacy duplicate primaries (demote all but the newest per address)
-- ---------------------------------------------------------------------------
WITH ranked_primaries AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "address"
            ORDER BY "created_at" DESC, "username" DESC
        ) AS "rn"
    FROM "username_registry"
    WHERE "is_primary" = true
      AND "deleted_at" IS NULL
)
UPDATE "username_registry" AS ur
SET "is_primary" = false
FROM ranked_primaries AS rp
WHERE ur."id" = rp."id"
  AND rp."rn" > 1;

-- ---------------------------------------------------------------------------
-- 2. Enforce the active-primary invariant
-- ---------------------------------------------------------------------------
-- Partial unique index: at most one active primary username per address.
-- Soft-deleted rows are excluded so they never block promotion of a new
-- primary. The index is additive and does not affect non-primary rows.
CREATE UNIQUE INDEX "username_registry_one_primary_per_address"
    ON "username_registry"("address")
    WHERE "is_primary" = true
      AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Rollback (CONTRACT phase / manual rollback)
-- ---------------------------------------------------------------------------
-- The index is additive, so rolling back the application does not require
-- dropping it. To fully revert this migration:
--
--   DROP INDEX IF EXISTS "username_registry_one_primary_per_address";
--
-- Note: the demotion performed in step 1 is intentionally NOT reversed.
-- Restoring duplicate primaries would reintroduce the ambiguous reverse
-- federation lookups this migration fixes, and the original "winner" cannot
-- be reconstructed reliably. If a specific address needs a different primary,
-- promote it explicitly:
--
--   UPDATE "username_registry"
--   SET "is_primary" = true
--   WHERE "address" = $1 AND "username" = $2 AND "deleted_at" IS NULL;
--
-- (Run only after the index has been dropped, or after demoting the current
-- primary for that address.)