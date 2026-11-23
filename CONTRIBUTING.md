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

## SBOMs for releasable artifacts

Every releasable software artifact must ship with a software bill of materials
(SPDX or CycloneDX) that is tied to the source revision and the artifact
digest. When you change dependencies or build outputs, regenerate and validate
the manifests locally before opening a pull request:

- Run `npm run sbom:node` to regenerate the Node manifest.
- Run `npm run sbom:validate` to check the generated manifests (schema,
  source revision, and artifact digest linkage).
- Ensure the CI SBOM checks pass; a failing SBOM check blocks the release.

If you add a new releasable artifact (for example a new Rust binary or
container image), wire SBOM generation into its release workflow so the
manifest is produced, validated, and attached to the release alongside the
artifact.

## Pull requests

- Keep changes scoped to the issue being addressed.
=======
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.

## Questions

If anything is unclear, open an issue and we will help out.
