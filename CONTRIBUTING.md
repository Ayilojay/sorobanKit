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

## CI hardening policies

Our production workflows follow a few hardening rules. Keep them in mind when
you touch anything under `.github/workflows/`.

### Pinned GitHub Actions

- **Every external action must be pinned to a reviewed, full 40-character
  commit SHA.** Tags and branches are mutable and are not accepted.
- Add a readable version comment on the same line so reviewers can tell which
  release the SHA corresponds to, for example:

  ```yaml
  - uses: actions/checkout@<40-char-sha> # v4.1.7
  ```

- **Manual bump procedure:** resolve the release tag to its commit SHA (for
  example with `git ls-remote --tags <repo-url> <tag>` or the GitHub UI),
  review the diff between the old and new SHA, update both the SHA and the
  `# vX.Y.Z` comment, and run the pinning check locally before pushing.
- **Dependabot update flow:** Dependabot opens pull requests that bump the
  pinned SHA and the version comment together. Review the upstream changelog
  and diff, then let CI run the pinning check before merging. Do not merge a
  Dependabot PR that drops the SHA pin or the version comment.

### Workflow concurrency

- Concurrency groups are scoped by **workflow and ref** (for example
  `${{ github.workflow }}-${{ github.ref }}`) so that runs for different
  workflows or branches never block each other.
- **Validation workflows** (tests, lint, typecheck, contract checks) set
  `cancel-in-progress: true` so a new push to a pull request cancels obsolete
  runs.
- **Deploy and release workflows** set `cancel-in-progress: false` so an
  in-flight deployment or release is never interrupted.

### Lockfile-reproducible installs

- Dependency installation in CI must be reproducible from the committed
  lockfiles. Use `npm ci` in each Node workspace rather than `npm install`.
- The root, `stellar-payment-platform`, and `payment-dashboard` workspaces are
  verified independently, each against its own lockfile.
- Avoid `--legacy-peer-deps` and similar flags. If a workspace genuinely
  requires one, document the flag and its rationale in this section and in the
  workflow step that uses it.

### Running the CI checks locally

The CI hardening checks are available as scripts and can be run before
pushing:

- Run the action-pinning check to confirm every external action uses a
  40-character SHA with a version comment.
- Run the workflow concurrency check to confirm validation workflows cancel
  superseded runs and deploy/release workflows do not.
- Run the lockfile check to confirm each workspace installs with `npm ci` and
  that the lockfiles are committed and in sync.

See the script headers and the workflow files for the exact commands and any
workspace-specific flags.

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

## Pull requests

- Keep changes scoped to the issue being addressed.
- Update operational, API, contract, migration, or contributor documentation
  and generated artifacts where your change affects them.
- Describe the validation you performed, including exact commands and results.

## Questions

If anything is unclear, open an issue and we will help out.
