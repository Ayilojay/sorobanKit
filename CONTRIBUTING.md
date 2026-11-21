# Contributing

Thanks for your interest in contributing! This guide covers local setup, the
checks we run in CI, and the requirements for building and deploying Soroban
contracts.

## Getting started

1. Fork and clone the repository.
2. Install dependencies with your package manager of choice (see the root
   `package.json` for the supported toolchain).
3. Create a branch off `main` for your change.

## Local checks

Before opening a pull request, run the focused workspace tests and the
applicable build, lint, and typecheck commands. Report the exact commands and
results in the pull request description.

## Soroban WASM builds

Soroban contract WASM artifacts must be **reproducible and hash-verifiable**.
Anyone building the same source revision with the pinned toolchain must get a
byte-identical artifact.

### Pinned inputs

WASM builds are pinned to the following inputs. Do not bump these casually —
changing any of them changes the resulting artifact hash and must be done in a
dedicated pull request that updates the recorded checksums.

- **Rust toolchain**: pinned via `rust-toolchain.toml` (see the file for the
  exact channel and components). Build with the pinned toolchain, not a
  locally-installed default.
- **Soroban SDK**: pinned in the contract crate's `Cargo.toml` / `Cargo.lock`.
  Commit `Cargo.lock` so dependency resolution is deterministic.
- **Optimizer**: `stellar contract optimize` from the pinned Stellar CLI
  version. Record the CLI version alongside the artifact metadata.

### Building

Build contracts with the pinned toolchain and optimizer, for example:

```sh
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/<contract>.wasm
```

### Source revision metadata and checksums

Every built WASM artifact must ship with metadata that makes it verifiable:

- the **source revision** (git commit SHA) the artifact was built from, and
- the **sha256 checksum** of the final (optimized) WASM.

Emit these alongside the artifact so downstream consumers and the deploy
pipeline can verify provenance. Do not commit artifacts without their
metadata.

### Verifying reproducibility

Before deploying, the pipeline rebuilds the contract from the same source
revision and compares the result against the recorded artifact. The build
**must fail** if the repeat build is not byte-identical (checksum mismatch).

To verify locally, build twice from a clean checkout and compare checksums:

```sh
sha256sum target/wasm32-unknown-unknown/release/<contract>.wasm
```

If the checksums differ, the build is not reproducible — investigate the
toolchain, SDK, or optimizer version before proceeding. Never deploy an
artifact whose checksum cannot be reproduced.

## Token-contract behavior the router supports

The router integrates with SEP-41-style token contracts. Because tokens are
third-party code, the router must tolerate hostile or non-conforming behavior
without corrupting its own accounting. The supported compatibility boundary is:

- **Transfers** may revert (panic), return an error, or return `false`. The
  router treats any of these as a failed transfer and rolls back the enclosing
  operation — no partial state is persisted.
- **Balance queries** may revert or return an error. The router must not assume
  a balance read succeeds; failures surface as errors rather than panics in
  router state.
- **Insufficient balance** and **zero-amount** transfers are boundary cases the
  router must handle explicitly (reject or no-op) rather than relying on the
  token to enforce them.
- **Fee and refund accounting** must remain consistent when a token fails
  mid-operation: fees are not charged and refunds are not double-counted on a
  rolled-back operation.

Tokens that violate these assumptions (e.g. silently succeed while moving no
funds, or mutate state before reverting) are **out of scope** and unsupported.

### Hostile token test fixtures

The test suite includes fixture token contracts that deliberately revert or
fail at transfer and balance boundaries. When adding router logic that touches
tokens, cover it with these fixtures:

- success paths against a well-behaved token,
- boundary cases (insufficient balance, zero amount),
- expected failures (transfer revert, balance-query failure), and
- rollback/recovery, asserting fee and refund accounting after a mid-operation
  failure.

## Pull requests

- Keep changes focused and scoped to the linked issue.
- Include tests covering success, boundary, and expected-failure cases, plus
  concurrency or recovery behavior where relevant.
- Update documentation and generated artifacts affected by your change.
