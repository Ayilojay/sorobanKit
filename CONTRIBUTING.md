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

## Release and deployment pipeline

The release pipeline builds one immutable backend artifact and promotes it by
digest through staging and production. Environment configuration lives outside
the image, so the same artifact is deployed everywhere. If you change anything
that affects a release, follow the expectations below.

### Build once, promote by digest

- Do not rebuild per environment. The artifact built for staging is the exact
  artifact promoted to production, identified by its digest.
- Deployment records the approver and deployment identity, and supports
  rollback to a previously verified digest. Keep these records intact when
  changing deployment tooling.
- Environment-specific values (endpoints, credentials, network selection) must
  be supplied as configuration, never baked into the artifact.

### Release manifest

The coordinated release manifest records package versions, the WASM hash, the
interface schema, supported networks, and the migration level. Update the
manifest whenever any of these change:

- package versions (API, dashboard, client),
- the compiled WASM hash,
- the interface schema,
- the set of supported networks,
- the migration level.

Deployment preflight rejects mismatched dashboard/client/contract
combinations, so a stale manifest will block a release. Regenerate the manifest
as part of your change rather than editing it by hand where a generator exists.

### Migration compatibility preflight

Production schema changes are gated by a compatibility preflight that tests
candidate migrations against both the old and new application versions.

- Destructive contract phases are blocked until old replicas are drained.
- Incompatible statements are reported before deployment; treat a failing
  preflight as a hard stop.
- Split schema changes into expand/contract phases so old and new versions can
  run side by side during rollout.

### Post-deployment smoke checks

After deploying to testnet, run the smoke checks against the deployed contract.
They verify the on-chain WASM hash, network, admin state, and read interface,
and use bounded, non-duplicating test transactions. Publish the results
together with the deployment ID.

### Validation to report

Run the focused workspace tests and the applicable build, lint, typecheck,
migration, or contract checks, plus the release-specific checks affected by
your change:

- the migration compatibility preflight for any migration or schema change,
- the release manifest generation/validation for any version, WASM, schema,
  network, or migration-level change,
- the post-deployment smoke checks when your change affects the deployed
  contract or its read interface.

Report the exact commands and their results in the pull request description.

## Pull requests

- Keep changes scoped to the issue being addressed.
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.

## Questions

If anything is unclear, open an issue and we will help out.
