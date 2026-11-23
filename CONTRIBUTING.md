# Contributing

Thanks for your interest in contributing! This document covers the basics of
setting up the project, running checks, and the expectations we have for pull
requests.

## Getting started

1. Fork the repository and create a topic branch from `main`.
2. Install dependencies with your package manager of choice.
3. Make your change, keeping the diff focused on the issue you are solving.

## Running checks

Before opening a pull request, run the focused workspace tests and the
applicable build, lint, typecheck, migration, or contract checks. Report the
exact commands you ran and their results in the pull request description.

## Contract upgrades and ledger snapshots

Contract upgrades are validated by simulating candidate migrations against
representative ledger snapshots. When you change migration logic or the
supported state versions, keep the following in mind:

- **Supported state versions.** Snapshots are provided for each supported
  state version. Add or update a synthetic snapshot whenever a new state
  version becomes supported, and remove snapshots for versions that are no
  longer supported.
- **Reject unsupported layouts first.** Unsupported snapshot layouts and
  state versions must be rejected *before* any mutation is performed. Never
  apply a migration to a snapshot whose layout is not recognized.
- **Critical reads and invariants.** After applying a candidate migration,
  the simulation runs critical reads and invariant checks. If you add a new
  invariant, wire it into the simulation so regressions are caught.
- **Tests.** Focused automated tests should cover the success path, version
  boundaries, expected failures (including unsupported layouts), and
  recovery or concurrency behavior where relevant.

## Expand-contract migrations

Schema changes must be safe for rolling deploys, where old and new application
versions run side by side. Follow the expand-contract workflow:

1. **Expand.** Add the new schema additively: new nullable columns, new tables,
   new indexes (created concurrently where possible). Nothing in this phase may
   break the currently deployed version.
2. **Dual-read/write.** Update the application to write to both the old and new
   locations and to read from the new location with a fallback to the old one.
   Deploy this before relying on the new schema.
3. **Backfill.** Populate the new columns or tables from existing data in
   bounded, resumable batches. Backfills must be idempotent and safe to rerun.
4. **Contract.** Only after all old application versions are drained may you
   remove the old columns, tables, or constraints. Destructive changes belong
   in a separate, later migration.

### Migration lint guard

CI runs a migration lint that rejects destructive statements (for example
`DROP COLUMN`, `DROP TABLE`, or narrowing type changes) in the same release as
the expand step. If a destructive change is genuinely intended and the old
versions have been drained, opt in explicitly by running the lint with
`--allow-destructive` and explain the rollout plan in the pull request.

### Example

See the example migration directory for an end-to-end expand-contract walk
through, including the rollback steps for each phase.

## Primary federation username invariant

Each address may have at most one active primary federation username. This is
enforced in PostgreSQL with a partial unique index over the active primary
rows, so concurrent writers cannot create a second primary.

- **Soft deletes.** Deleting or deactivating a username is a soft delete: the
  row is marked inactive rather than removed. Inactive rows are excluded from
  the partial unique index, so a new primary can be created for the same
  address after the previous one is deactivated.
- **Repairing legacy data.** Before the constraint is applied, any legacy
  duplicates (multiple active primaries for one address) must be repaired by
  deactivating all but the intended primary. The migration fails rather than
  silently dropping data if duplicates cannot be resolved.

## Pull requests
=======

- Keep changes scoped to the issue being addressed.
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.

## Questions

If anything is unclear, open an issue and we will help out.
