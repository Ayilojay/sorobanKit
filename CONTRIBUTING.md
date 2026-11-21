# Contributing to Stellar Tags

Thanks for your interest in improving Stellar Tags! This guide walks you through the development workflow, conventions, and review process so you can get productive quickly.

> **Security:** Please do not report security vulnerabilities through public issues or pull requests. See [SECURITY.md](SECURITY.md) for our responsible disclosure process.

## Prerequisites

- **Node.js** 18+ and **npm** (for the frontend)
- **Rust** (stable toolchain) and **Cargo** (for the backend)
- **Git**

## Local Setup

1. Fork the repository and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/stellar-tags.git
   cd stellar-tags
   ```
2. Install frontend dependencies:
   ```bash
   npm install
   ```
3. Build the backend:
   ```bash
   cargo build
   ```
4. Start the development servers as described in the [README](./README.md).

## Branching Strategy

- Branch off `main` for all work.
- Use a descriptive, prefixed branch name:
  - `feat/<short-description>` for new features
  - `fix/<short-description>` for bug fixes
  - `docs/<short-description>` for documentation
  - `chore/<short-description>` for maintenance
- Keep branches focused on a single issue or change.

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>

### All workspaces at once

Run every test suite in sequence from the repo root with a single command:

```bash
npm run test:all
```

This runs the frontend tests, then the backend tests, then the Soroban contract tests (`cargo test`). The command exits non-zero as soon as any suite fails, so a red result always tells you which workspace broke. CI runs this same command in the `test-all` job.

### Frontend

```bash
cd payment-dashboard
npm test
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

```bash
cd stellar-payment-platform
npm test
```

## Code Style

- **Frontend (TypeScript/JavaScript):** run ESLint before committing:
  ```bash
  npm run lint
  ```
- **Backend (Rust):** format and lint with Clippy:
  ```bash
  cargo fmt
  cargo clippy -- -D warnings
  ```
- Match the existing structure, naming, and patterns in the codebase.

## Pre-commit Hook

This repository uses [Husky](https://typicode.github.io/husky/) to run checks before each commit (see `.husky/pre-commit`). The hook runs:

1. **Lint** — `npm run lint` (ESLint).
2. **Unit tests** — `npm run test:unit`, which runs Jest against `tests/unit` only (`--testPathPattern=tests/unit --passWithNoTests`).

The hook is intentionally limited to a fast subset of tests so it completes in under 30 seconds on a modern developer machine. Integration and e2e tests, as well as Rust tests, are **not** run in the hook — they are covered by CI. A failing unit test will block the commit; fix the failure (or, if you must, bypass with `git commit --no-verify`, though CI will still enforce the checks).

## Tests

All changes should include or update tests where appropriate. Run the full test suite before opening a PR:

```bash
cd payment_router
cargo test
```

## Payment Router State-Transition Specification

The payment router is a state machine. This section is the public contract for its
state, actors, transition preconditions, emitted events, and rollback behavior. Each
transition is backed by a Rust test or invariant in the `payment_router` workspace; when
you change a transition, update the corresponding test and this table in the same PR.

### Public state

| State | Meaning |
| --- | --- |
| `Active` | Router accepts payments, refunds, and pause/freeze/governance operations. |
| `Paused` | Payments are rejected; refunds and governance operations remain available. |
| `Frozen` | All value-moving operations (payments and refunds) are rejected; only governance can unfreeze. |

### Actors

- **Payer** — submits payments and requests refunds.
- **Admin** — pauses/unpauses the router and freezes it.
- **Governance** — unfreezes the router and applies governance parameter changes.

### Transitions

| Operation | From → To | Preconditions | Emitted event | Rollback |
| --- | --- | --- | --- | --- |
| Payment | `Active` → `Active` | Router `Active`; amount within configured limits; payer authorized | `PaymentRouted` | Atomic: no state or balance change on failure |
| Pause | `Active` → `Paused` | Caller is `Admin`; router `Active` | `RouterPaused` | Atomic: state unchanged on failure |
| Unpause | `Paused` → `Active` | Caller is `Admin`; router `Paused` | `RouterUnpaused` | Atomic: state unchanged on failure |
| Freeze | `Active`/`Paused` → `Frozen` | Caller is `Admin`; router not already `Frozen` | `RouterFrozen` | Atomic: state unchanged on failure |
| Unfreeze | `Frozen` → `Active` | Caller is `Governance`; router `Frozen` | `RouterUnfrozen` | Atomic: state unchanged on failure |
| Refund | `Active` → `Active` | Router `Active`; original payment exists and is refundable | `PaymentRefunded` | Atomic: no state or balance change on failure |
| Governance | `Active`/`Paused` → same | Caller is `Governance`; parameters valid | `GovernanceUpdated` | Atomic: parameters unchanged on failure |

### Invariants

- A `Frozen` router never emits `PaymentRouted` or `PaymentRefunded`.
- Every transition is all-or-nothing: a failed precondition leaves state, balances, and
  emitted events untouched (Soroban rolls back the invocation).
- Only `Governance` can move the router out of `Frozen`.

### Tests

Focused tests covering success, boundary, expected-failure, and recovery paths live in
the `payment_router` workspace:

```bash
cd payment_router
cargo test
```

## Instruction and Storage Budgets

Public contract methods on the routing and governance paths are covered by reproducible resource budgets so that regressions are caught before they reach `main`. The budgets record CPU instructions, memory, ledger read/write counts, and entry size for each public method, and are enforced by focused tests in the contract workspace.

### What is recorded

For every public routing and governance method the budget suite captures:

- **CPU instructions** — total instructions consumed by the invocation.
- **Memory** — peak memory bytes used during execution.
- **Read/write counts** — number of ledger entries read and written.
- **Entry size** — serialized size of the largest entry written.

Budgets are stored alongside the contract tests and are deterministic: they are derived from the same inputs on every run, so a diff in the recorded numbers always reflects a real change in behavior.

### Worst-case failures

The budget tests also exercise worst-case scenarios (maximum batch sizes, largest payloads, and full-capacity governance operations) so that the recorded ceilings reflect the true upper bound of each method rather than a best-case path. Expected-failure cases (e.g. exceeding a configured limit) are asserted to fail with the documented error rather than silently consuming unbounded resources.

### Running the budget tests

```bash
cd payment_router
cargo test budget
```

### Updating budgets

If a change intentionally alters resource usage, update the recorded budgets in the same PR and explain the delta in the PR description. CI fails on material regressions against the recorded budgets, so an unexplained increase will block the merge. Keep budget updates in their own commit where practical to make review easier.

## Pull Requests

1. Push your branch to your fork and open a PR against `main`.
2. Fill out the PR template (`.github/pull_request_template.md`) completely.
3. Link the issue your PR addresses (e.g. `Closes #123`).
4. Ensure CI passes and all tests are green.
5. Respond to review feedback promptly. A maintainer will review and merge once approved.

## Questions?

If anything here is unclear, open an issue or start a discussion — we're happy to help.
