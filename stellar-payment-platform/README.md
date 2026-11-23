# Stellar Payment Platform

A payment platform built on the Stellar network.

## Table of Contents

- [Getting Started](#getting-started)
- [Database Setup](#database-setup)
- [Migrations](#migrations)
- [Configuration](#configuration)
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

## Idempotency Records

Replay keys are persisted in the database so that concurrent or retried requests converge on a single outcome:

- The replay key is stored **hashed**; raw keys are never persisted.
- Each record stores a request fingerprint (hash of the request payload) and the operation outcome.
- A unique constraint on the hashed replay key guarantees that concurrent inserts converge: the loser of the race reads the winner's record and replays its outcome instead of re-executing the command.
- The idempotency record is written in the **same transaction** as the business command, so a command and its idempotency record are committed or rolled back together.
- A request that reuses a replay key with a different fingerprint is rejected as a conflict.
- Records are retained for a bounded period (`IDEMPOTENCY_RETENTION_HOURS`, default `24`) and expired records are purged by a periodic cleanup job.

## Transactional Outbox

Domain events are persisted through a transactional outbox:

- Outbox rows are written in the **same transaction** as the domain change, so an event is never lost when the business command commits.
- Rows are versioned and dispatched by a background worker with bounded retries and exponential backoff; exhausted events are marked as failed for operator inspection.
- Consumers are idempotent: each event carries a stable event ID and consumers deduplicate on it, so redelivery is safe.
- A reconciliation query lists stuck events (pending beyond the expected dispatch window or failed after exhausting retries) for operators to inspect and replay.

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
