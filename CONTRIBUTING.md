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

## Pull requests

- Keep changes focused and scoped to the linked issue.
- Include tests covering success, boundary, and expected-failure cases, plus
  concurrency or recovery behavior where relevant.
- Update documentation and generated artifacts affected by your change.
