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

## Preview environments for pull requests

Pull requests can be provisioned with an isolated, ephemeral preview
environment containing the API and dashboard. Previews are meant for manual
verification and review; they are never connected to production.

- **Isolation.** Each preview gets its own database and synthetic seed data.
  Production credentials are never injected into a preview. Only the
  preview-only secrets described below are available to the workload.
- **Preview-only secrets.** Configure preview secrets under the preview
  environment scope (for example `PREVIEW_DATABASE_URL`,
  `PREVIEW_API_TOKEN`, and `PREVIEW_DASHBOARD_SESSION_SECRET`). These values
  must be distinct from production and must not grant access to production
  systems. Never reuse production credentials for a preview.
- **TTL policy.** Every preview is created with a time-to-live. When the TTL
  elapses the environment is torn down automatically, even if the pull
  request is still open. Re-run the preview workflow to provision a fresh
  environment.
- **Auditable cleanup.** Closing or merging a pull request triggers cleanup of
  the associated preview resources. Cleanup is recorded in an audit log that
  captures what was removed, when, and by which trigger (TTL expiry or PR
  closure). If you notice orphaned preview resources, report them in the
  issue so the audit trail can be reconciled.

## Pull requests

- Keep changes scoped to the issue being addressed.
=======
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.

## Questions

If anything is unclear, open an issue and we will help out.
