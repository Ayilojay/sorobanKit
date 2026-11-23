# Stellar Payment Platform

A payment platform built on the Stellar network.

## Table of Contents

- [Getting Started](#getting-started)
- [Database Setup](#database-setup)
- [Migrations](#migrations)
- [Configuration](#configuration)
- [Graceful Shutdown](#graceful-shutdown)
- [Audit Integrity](#audit-integrity)
- [Horizon Stream Cursors](#horizon-stream-cursors)
- [Authentication and Ownership](#authentication-and-ownership)
- [Testing](#testing)

## Getting Started

Install dependencies and configure your environment:

```bash
npm install
cp .env.example .env
```

## Database Setup

The platform uses PostgreSQL via Prisma. Before running the application, ensure your database is reachable and your Prisma schema is applied.

```bash
npx prisma generate
npx prisma migrate deploy
```

### Prisma `metrics` Preview Feature (Pool Monitoring)

The database pool monitor (`src/db-pool-monitor.js`) reads Prisma's `$metrics` API to populate the `db_pool_connections_open` and related gauges. This API is only available when the `metrics` preview feature is enabled in `schema.prisma`.

If the preview feature is **not** enabled:

- `prisma.$metrics` is `undefined`, and the monitor cannot read pool statistics.
- The `db_pool_monitoring_available` gauge is set to `0`.
- All pool gauges (e.g. `db_pool_connections_open`) report `0`, which can be misleading.
- A `warn`-level message is logged at startup indicating that pool monitoring is unavailable.

To enable pool monitoring, add the `metrics` preview feature to the `generator` block in `prisma/schema.prisma`:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["metrics"]
}
```

Then regenerate the Prisma client:

```bash
npx prisma generate
```

When the feature is enabled, `db_pool_monitoring_available` is set to `1` and the monitor polls `$metrics` on its normal interval.

> **Note:** Enabling the `metrics` preview feature is an operator choice. Deployments that do not require pool monitoring can leave it disabled; the `db_pool_monitoring_available` gauge provides a clear signal that monitoring is degraded.

## Migrations

The application can run a migration drift check at startup, controlled by the `MIGRATION_POLICY` environment variable.

### `MIGRATION_POLICY`

| Value    | Behaviour                                                                 |
| -------- | ------------------------------------------------------------------------- |
| `off`    | Skip the drift check entirely.                                            |
| `warn`   | Log a warning if drift is detected, but continue startup.                 |
| `strict` | Log an error and exit the process with code `1` if drift is detected.     |

Under `MIGRATION_POLICY=strict`, when drift is detected the migration check flushes all log buffers **before** calling `process.exit(1)`. This ensures the error is written to disk and visible in the logs even in environments such as PM2 or Docker with `restart: always`, where the process may otherwise be restarted before the log line is flushed. The exit code is propagated through `startup.sh` so that Docker health checks and orchestrators can observe the failure.

### Serialized migration execution (advisory lock)

When several replicas start at the same time they must not apply migrations concurrently. Before applying migrations the runner acquires a bounded PostgreSQL advisory lock (`pg_try_advisory_lock` on a fixed key, polled until acquired or until the timeout elapses). Only the lock owner applies migrations; the other replicas wait and then observe that the migrations are already applied, so each migration is applied exactly once.

- The lock is always released in a `finally` block, including when a migration fails, so a failed startup never leaves the lock held.
- If the lock cannot be acquired within the timeout, startup fails with a structured error instead of racing the owner.
- Structured logs are emitted for lock acquisition (`owner`), waiting (`wait`), and failure (`failure`) events, including the replica identity and elapsed wait time.

| Variable                          | Default | Description                                                        |
| --------------------------------- | ------- | ------------------------------------------------------------------ |
| `MIGRATION_LOCK_TIMEOUT_MS`       | `60000` | Maximum time to wait for the advisory lock before failing startup. |
| `MIGRATION_LOCK_POLL_INTERVAL_MS` | `1000`  | Interval between advisory lock acquisition attempts.               |

### Checksum manifest and schema-version preflight

The migration runner records a manifest of every applied migration together with a SHA-256 checksum of its file contents. During preflight it:

- Verifies that historical migration files have not changed (a changed checksum is reported as drift).
- Compares the recorded schema version against the expected version and reports schema drift.
- Reports the currently deployed schema version without modifying any data.

The manifest is written to deployment metadata and is safe to read at any time; preflight is read-only.

## Configuration

Configuration is provided via environment variables. See `.env.example` for the full list.

## Graceful Shutdown

On `SIGTERM`/`SIGINT` the server performs an ordered, idempotent shutdown:

1. Stop accepting new HTTP connections and stop scheduling new background work.
2. Allow bounded in-flight requests and jobs to finish.
3. Close workers, then Redis, then Prisma, in that order.

Shutdown is idempotent: repeated signals or concurrent triggers run the sequence once. A configurable deadline bounds the whole sequence; if it expires, remaining resources are force-closed and the process exits non-zero.

| Variable                     | Default | Description                                                        |
| ---------------------------- | ------- | ------------------------------------------------------------------ |
| `SHUTDOWN_TIMEOUT_MS`        | `30000` | Maximum time to wait for in-flight work before force-closing.      |
| `SHUTDOWN_DRAIN_GRACE_MS`    | `5000`  | Grace period for in-flight HTTP requests to complete.              |

## Audit Integrity

Administrative audit events are canonicalized and integrity-linked: each record stores a keyed digest over its canonical form plus the previous record's digest, forming a verifiable chain. Redaction rules are applied before hashing, and existing query behaviour is unchanged.

| Variable                     | Default | Description                                                        |
| ---------------------------- | ------- | ------------------------------------------------------------------ |
| `AUDIT_HMAC_KEY`             | —       | Current key used to compute audit digests. Required in production. |
| `AUDIT_HMAC_KEY_ID`          | —       | Identifier recorded alongside each digest for rotation.            |
| `AUDIT_HMAC_PREVIOUS_KEYS`   | —       | JSON map of `keyId -> key` accepted during verification/rotation.  |

Key rotation: add the new key as `AUDIT_HMAC_KEY` with a new `AUDIT_HMAC_KEY_ID`, move the old key into `AUDIT_HMAC_PREVIOUS_KEYS`, and run the verification tooling to confirm the chain still validates across the rotation boundary. Verification tooling recomputes digests for a range of records and reports the first break, if any.

## Horizon Stream Cursors

Per-network stream cursors are persisted atomically **after** a page is fully processed, so a crash resumes from the last committed point rather than replaying or skipping pages. Duplicate pages are idempotent.

Processing is split into two modes:

- **Backfill** — scans historical pages from a configured starting cursor up to the live head.
- **Live-tail** — follows new pages from the last committed cursor.

| Variable                          | Default | Description                                                    |
| --------------------------------- | ------- | -------------------------------------------------------------- |
| `HORIZON_BACKFILL_START_CURSOR`   | `now`   | Starting cursor for initial backfill (`now` or a paging token). |
| `HORIZON_STREAM_MODE`             | `auto`  | `backfill`, `live`, or `auto` (backfill then live-tail).        |

## Authentication and Ownership

Requests carry a typed principal derived from the authenticated session. Resource ownership checks are centralized in routes and services and compare against the principal — never against caller-supplied usernames or addresses. Public federation reads remain unauthenticated and are unaffected by ownership checks.

## Testing

Run the test suite:

```bash
npm test
```

Focused validation for the migration, idempotency, and outbox changes:

```bash
npm test -- --testPathPattern='(migration|idempotency|outbox)'
npm run lint
npm run build
npx prisma migrate deploy
```
