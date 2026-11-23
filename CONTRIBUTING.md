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

## Payment deep links

Authorized payment details are reachable through stable, shareable routes.
When adding or changing these routes:

- **No credentials in URLs.** Never put bearer tokens, signing material, or
  other secrets in a path, query string, or fragment. Links carry only
  non-sensitive identifiers; authorization is re-established on navigation.
- **Authorization and not-found behavior.** Unauthorized requests must not
  reveal whether a payment exists. Return the same not-found response for
  missing and unauthorized payments.
- **Expiry.** Expired links must fail with an explicit expiry state and a
  recovery action, not a generic error.
- **Navigation.** Preserve refresh and browser history behavior: deep links
  must survive a hard refresh and back/forward navigation.
- **Tests.** Cover the success path, authorization boundaries, not-found,
  expiry, and refresh/history behavior.

## Local payment drafts

Locally saved payment drafts follow explicit lifecycle rules:

- **Non-secret fields only.** Persist only non-secret fields, and always bind
  a draft to the account and network it was created under.
- **Clear and delete controls.** Users must be able to clear or delete a
  draft, and drafts expire automatically.
- **Incompatible drafts are discarded.** When the active account or network
  changes, drafts bound to the previous account or network are discarded
  rather than reused.
- **Tests.** Cover persistence, expiry, explicit clear/delete, and discard on
  account or network change.

## Shared state components

Empty, loading, retry, and partial-data states use shared, accessible
components:

- Distinguish empty results from errors; an empty list is not a failure.
- Preserve usable content when secondary requests fail (partial data).
- Keep page-specific recovery actions (retry, refresh, navigate) wired to the
  shared components rather than reimplementing state markup per page.
- **Tests.** Cover empty, loading, error/retry, and partial-data rendering,
  including accessibility expectations.

## Selective CI

Monorepo CI runs selectively based on the changed workspaces and the
dependency graph:

- **Path-aware jobs.** Independent packages run their own jobs only when
  their paths (or their dependencies) change.
- **Dependency-aware fan-out.** Changes to shared schemas, generated bindings,
  root configuration, or lockfiles fan out to every workspace that depends on
  them.
- **Full-suite fallback.** When change detection cannot confidently determine
  the affected workspaces (for example, unrecognized paths or detection
  failures), CI falls back to running the full suite.
- **Tests.** Cover path-aware selection, dependency fan-out, and the
  full-suite fallback.

## Pull requests
=======

- Keep changes scoped to the issue being addressed.
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.

## Questions

If anything is unclear, open an issue and we will help out.
