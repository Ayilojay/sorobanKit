# Deployment Checklist

Use this checklist for every deployment. Do not skip steps.

## Pre-Deployment

- [ ] All changes merged to `main` and CI is green
- [ ] Version/tag decided and changelog updated
- [ ] Required secrets and environment variables are configured
- [ ] Confirm `MIGRATION_POLICY: strict` is set in `render.yaml` so production
      deploys fail fast on pending migrations instead of starting in `warn` mode
- [ ] Run the governance contract identity preflight against the candidate
      governance contract and confirm it reports the expected contract identity
      (address/version/interface) before any timelocked authority change is
      scheduled. A candidate whose interface handshake does not match the
      expected version must be rejected and must not be delegated to.
- [ ] Run the migration lint against the candidate migrations and confirm it
      passes (no destructive changes outside a contract phase):
      `npm run migration:lint`
- [ ] Confirm every migration in the release follows the expand-contract phases
      documented in `docs/migrations/expand-contract.md` and that the release
      notes list the phase for each migration.
- [ ] Confirm the primary-federation-username invariant migration
      (`migrations/20240601000000_primary_username_invariant.sql`) has been
      applied and that the legacy duplicate-primary repair step ran cleanly
      (see *Primary Username Invariant* below).
- [ ] Review the end-to-end example migration in
      `migrations/examples/expand-contract-example/` and confirm the release
      follows the same phase/rollback structure.

## Testnet Deployment

- [ ] Push (or merge) to `main` to trigger the `deploy-testnet` workflow
- [ ] **Manual approval required:** the `deploy-testnet` workflow is gated by the
      `testnet` GitHub environment. A required reviewer must approve the run in
      the Actions UI before any deploy steps execute.
- [ ] Confirm the approval prompt appears and approve it (Actions → the running
      workflow → *Review deployments* → select `testnet` → *Approve and deploy*)
- [ ] Verify the deploy steps run only after approval
- [ ] Configure `TESTNET_API_URL` in **Settings → Secrets and variables → Actions** (or under the `testnet` environment secrets) pointing to the deployed testnet API base URL so the post-deploy `/health` verification step can confirm `200 OK` and `status: "up"`
- [ ] Smoke-test the integration environment after the deploy completes

> The `testnet` environment must exist in **Settings → Environments** with at
> least one required reviewer configured, and `TESTNET_API_URL` must be set as a
> required repository secret. Without them, the approval gate or post-deploy
> health check will fail.

## Migrations (Expand-Contract)

Rolling deploys must never break the previous application version. Every schema
change is split into the phases below and each phase is deployed separately.
See `docs/migrations/expand-contract.md` for the full policy and
`migrations/examples/expand-contract-example/` for a worked example with
rollback steps.

### Phase 1 — Expand (deploy expand)

- [ ] Deploy the expand migration only (additive: new columns/tables/indexes,
      nullable or defaulted; no drops, renames, or type narrowing).
- [ ] Confirm the migration is backward compatible with the currently running
      application version.
- [ ] Deploy the application version that writes to both old and new shapes
      (dual-write) only after the expand migration has completed on all nodes.

Rollback (expand):

```bash
# Revert the expand migration (safe: nothing depends on it yet)
npm run migration:down -- <expand-migration-id>
```

### Phase 2 — Dual-read/write (deploy dual-write)

- [ ] Deploy the application version that reads from the old shape and writes
      to both old and new shapes.
- [ ] Verify both write paths succeed in logs/metrics before proceeding.
- [ ] Do not drop or stop writing the old shape until the backfill has
      completed and been verified.

Rollback (dual-write):

```bash
# Roll back the application to the previous version; the expand schema stays.
# No SQL rollback is required for this phase.
```

### Phase 3 — Backfill

- [ ] Run the backfill job/migration and confirm it is idempotent and
      resumable.
- [ ] Verify row counts and spot-check data before moving on.
- [ ] For the primary-username invariant, run the legacy duplicate repair
      before creating the partial unique index:

```sql
-- Repair legacy duplicate primaries: keep the most recent active primary
-- per address, demote the rest.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY address
           ORDER BY updated_at DESC, id DESC
         ) AS rn
  FROM federation_usernames
  WHERE is_primary AND deleted_at IS NULL
)
UPDATE federation_usernames f
SET is_primary = FALSE
FROM ranked r
WHERE f.id = r.id AND r.rn > 1;

-- Enforce at most one active primary per address.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  federation_usernames_one_active_primary_per_address
  ON federation_usernames (address)
  WHERE is_primary AND deleted_at IS NULL;
```

Rollback (backfill):

```bash
# Backfill is additive and idempotent; re-running is safe.
# To undo the invariant index:
psql "$DATABASE_URL" -c \
  "DROP INDEX CONCURRENTLY IF EXISTS federation_usernames_one_active_primary_per_address;"
```

### Phase 4 — Contract (deploy contract)

- [ ] Confirm the backfill has completed and been verified.
- [ ] Confirm no running application version still reads or writes the old
      shape.
- [ ] Deploy the contract migration (drops/renames/constraint tightening) and
      the application version that uses only the new shape.

Rollback (contract):

```bash
# Contract changes are destructive; roll back by restoring from the
# pre-contract backup taken immediately before this phase.
pg_restore --clean --if-exists -d "$DATABASE_URL" pre-contract.dump
```

## Post-Deployment

- [ ] Verify the deployed version/commit matches the intended release
- [ ] Monitor logs and metrics for errors
- [ ] Notify the team that the deployment is complete
