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

## Administrative permissions

Administrative access is no longer a single broad capability. Every admin
route must declare the permission it requires, and the permission is checked
centrally before the handler runs.

- **Pick the narrowest permission.** Use the read permission for inspection
  endpoints, the operational permission for day-to-day state changes, and the
  configuration-changing permission only for routes that alter configuration
  or policy.
- **Declare it on the route.** Register the permission alongside the route
  definition so the central check can enforce it. A route without a declared
  permission must fail closed rather than defaulting to broad access.
- **Audit sensitive decisions.** Record an audit entry for sensitive
  administrative decisions, including the actor, the permission used, the
  target, and the outcome.
- **Tests.** Cover each permission level: success with the required
  permission, rejection when the permission is missing, and rejection when a
  lower permission is presented for a higher-impact route.

## Step-up verification

High-impact administrative actions (contract upgrades, treasury changes, and
bulk exports) require a short-lived, single-use second confirmation bound to
the action and the payload hash.

- **Bind to action and payload.** The confirmation must be tied to both the
  action being performed and a hash of the payload, so it cannot be replayed
  against a different action or a modified payload.
- **Expiry and single use.** Confirmations expire quickly and are consumed on
  first use. Reject expired, already-consumed, or mismatched confirmations
  before performing any mutation.
- **Audit evidence.** Record the confirmation identifier, the action, the
  payload hash, and the outcome in the audit trail.
- **Tests.** Cover the success path, expiry boundaries, reuse of a consumed
  confirmation, payload mismatch, and the failure behavior when verification
  is missing.

## Migrations for new models

When you add models for key rotation metadata, permissions, or step-up
confirmations, include a migration in the same pull request.

- Add the migration for every new or changed model and keep it reversible
  where the storage engine allows.
- Backfill or default any new columns so existing rows remain valid, and
  document the compatibility boundary in the migration notes.
- Update the generated artifacts (schema dumps, API contracts, and any
  generated clients) that your change affects.
- **Tests.** Cover the migration success path, the boundary between old and
  new state versions, and recovery when a migration is interrupted.

## Pull requests

- Keep changes scoped to the issue being addressed.
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.
- For changes touching admin permissions, step-up verification, or key
  rotation, run the focused workspace tests for those areas plus the
  applicable build, lint, typecheck, migration, and contract checks, and
  report each command with its result.

## Questions

If anything is unclear, open an issue and we will help out.
