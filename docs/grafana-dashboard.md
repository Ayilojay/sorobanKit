# Grafana Dashboard - DB Pool Monitoring

This document describes the Grafana dashboard for monitoring the Stellar Tags
database connection pool and system resources.

## Prerequisites

1. A running [Prometheus](https://prometheus.io/) instance scraping the
   `/metrics` endpoint of the Stellar Tags server.
2. Grafana with the Prometheus datasource configured.

## Importing the Dashboard

The dashboard uses a datasource template variable (`${DS_PROMETHEUS}`) instead
of a hardcoded datasource UID, so it can be imported into any Grafana instance
without editing the JSON. The `__inputs` section declares a `DS_PROMETHEUS`
input of type `datasource` with `pluginId` `prometheus`; Grafana prompts for it
during import.

1. Open Grafana and navigate to **Dashboards > Import**.
2. Click **Upload JSON file** and select `docs/grafana-dashboard.json`.
3. When prompted for the **Prometheus** datasource input (`DS_PROMETHEUS`),
   select your Prometheus datasource from the dropdown.
4. Click **Import**.

No manual edits to the JSON are required: every panel references the
`${DS_PROMETHEUS}` variable, which resolves to the datasource you selected.

If you prefer to import via the API, pass the datasource in the request body:

```sh
curl -X POST http://localhost:3000/api/dashboards/import \
  -H 'Content-Type: application/json' \
  -d '{
    "dashboard": <contents of docs/grafana-dashboard.json>,
    "overwrite": true,
    "inputs": [
      {
        "name": "DS_PROMETHEUS",
        "type": "datasource",
        "pluginId": "prometheus",
        "value": "<your-prometheus-datasource-uid>"
      }
    ]
  }'
```

The dashboard uid is `stellar-tags-db-pool` and can be accessed directly at
`/d/stellar-tags-db-pool`.

## Dashboard Panels

### Database Connection Pool

| Panel | Metric | Description |
| --- | --- | --- |
| Connection Pool State | `stellar_tags_db_pool_connections_{open,busy,idle}` | Time series showing open, busy, and idle connections over time. Yellow threshold at 15, red at 20. |
| Queries Waiting for Connection | `stellar_tags_db_pool_queries_waiting` | Queries queued because all pooled connections are busy. Yellow at 5, red at 20. |
| Pool Open / Busy / Waiting (stat) | Same as above | Current values as single-stat panels for at-a-glance status. |
| Redis Status | `stellar_tags_redis_connections_active` | `1` when Redis is connected, `0` otherwise. |

### HTTP Requests

| Panel | Metric | Description |
| --- | --- | --- |
| Request Rate by Status | `stellar_tags_http_requests_total` | Requests per second grouped by `status_code`. Stacked bars: green (2xx), blue (3xx), yellow (4xx), red (5xx). |
| Request Latency (p95 / p99) | `stellar_tags_http_request_duration_seconds` | Histogram quantiles per route. Yellow at 0.5s, red at 2s. |

### System Resources

| Panel | Metric | Description |
| --- | --- | --- |
| Memory Usage | `stellar_tags_process_resident_memory_bytes`, `stellar_tags_nodejs_heap_size_used_bytes` | Resident memory and V8 heap usage. |
| CPU Usage | `stellar_tags_process_cpu_user_seconds_total`, `stellar_tags_process_cpu_system_seconds_total` | User and system CPU time as a rate. |

### Webhook Queue Health

These panels visualize the health of the webhook delivery queue. All label
values are bounded (status codes are bucketed, event types are normalized to a
fixed set, and error reasons are mapped to a small enum) so the number of time
series stays predictable regardless of traffic volume.

| Panel | Metric | Description |
| --- | --- | --- |
| Oldest Pending Event Age | `stellar_tags_webhook_queue_oldest_pending_age_seconds` | Age of the oldest event still awaiting delivery. Yellow at 60s, red at 300s. |
| Pending Events | `stellar_tags_webhook_queue_pending_events` | Number of events currently queued for delivery. |
| Attempt Distribution | `stellar_tags_webhook_delivery_attempts` | Histogram of delivery attempts per event, bucketed (`1`, `2`, `3`, `4`, `5+`). |
| Delivery Latency (p95 / p99) | `stellar_tags_webhook_delivery_latency_seconds` | Histogram of end-to-end delivery latency per event type. Yellow at 5s, red at 30s. |
| DLQ Age | `stellar_tags_webhook_dlq_oldest_age_seconds` | Age of the oldest event in the dead-letter queue. Yellow at 1h, red at 24h. |
| DLQ Depth | `stellar_tags_webhook_dlq_depth` | Number of events in the dead-letter queue, grouped by bounded `reason` label. |

The same values are exposed for ad-hoc inspection through the admin endpoint
`GET /admin/webhooks/queue-health` (requires an admin token). It returns the
oldest pending event age, pending count, attempt distribution, delivery latency
quantiles, and DLQ age/depth as JSON, so operators can confirm what the
dashboard shows without opening Grafana.

## Importing the Webhook Queue-Health Dashboard

The webhook panels live in the same dashboard JSON
(`docs/grafana-dashboard.json`) and are imported exactly as described above:
upload the file, select your Prometheus datasource for the `DS_PROMETHEUS`
input, and click **Import**. No hardcoded datasource UIDs are used, so the
dashboard is portable across environments (local, staging, production). If you
maintain a separate dashboard, copy the `Webhook Queue Health` row and keep the
`${DS_PROMETHEUS}` references intact.

## Sustained-Load Benchmark

The benchmark exercises the critical user journeys under a realistic request
mix and records tail latency, error rates, memory, database pool usage, and
upstream calls over time.

### Request mix

| Journey | Weight | Notes |
| --- | --- | --- |
| Registration | 20% | Creates accounts; includes federation address checks. |
| Federation lookup | 40% | Read-heavy `GET /federation` lookups. |
| Payment initiation | 25% | Writes payment intents and triggers upstream calls. |
| History | 15% | Paginated history reads. |

### Running the benchmark

```sh
# Start the stack (server + Postgres + Redis) with the benchmark profile.
docker compose -f docker-compose.bench.yml up -d

# Run the sustained-load benchmark for 10 minutes at the configured rate.
pnpm bench:sustained -- --duration 10m --rate 50

# Results are written to bench/results/<timestamp>/ (JSON + summary.md).
```

The benchmark records the following over time:

- **Tail latency**: p50, p95, p99, and max per journey.
- **Errors**: counts by status code and by journey.
- **Memory**: resident memory and V8 heap usage sampled every 5s.
- **Pool usage**: open/busy/waiting connections sampled every 5s.
- **Upstream calls**: federation and payment-provider call counts and latency.

### Interpreting results

Compare p99 latency and error rate against the thresholds in
`bench/thresholds.json`. A run fails if any journey exceeds its p99 budget or
if the error rate exceeds 1%. Rising pool `waiting` counts alongside flat
throughput indicate pool saturation; growing heap usage without recovery
indicates a leak.

### Fault injection and cold start

```sh
# Inject upstream failures/timeouts to verify graceful degradation.
pnpm bench:faults -- --scenario upstream-timeout --duration 2m

# Measure cold-start latency (empty caches, fresh pool) before steady state.
pnpm bench:cold-start -- --iterations 20
```

## Template Variables

| Variable | Description |
| --- | --- |
| `DS_PROMETHEUS` | Prometheus datasource input, declared in the dashboard's `__inputs` section and selected during import. |
| `datasource` | Prometheus datasource selector. |
| `instance` | Filters by scrape target instance (multi-select, defaults to All). |

## Connection Capacity Budgeting

The database connection limit is shared by every replica that opens a pool.
The server aggregates the configured capacity across all replica types and
validates it against the database limit before accepting traffic, reserving
headroom for administrative connections.

### Capacity inputs

| Replica type | Env var | Per-replica pool size |
| --- | --- | --- |
| API | `API_REPLICAS` | `DB_POOL_MAX` |
| Worker | `WORKER_REPLICAS` | `DB_POOL_MAX` |
| Migration | `MIGRATION_REPLICAS` | `DB_POOL_MAX` |
| Monitoring | `MONITORING_REPLICAS` | `DB_POOL_MAX` |

Total configured capacity is
`(API_REPLICAS + WORKER_REPLICAS + MIGRATION_REPLICAS + MONITORING_REPLICAS) * DB_POOL_MAX`.

### Validation

Startup fails with a clear error when the aggregated capacity plus the
reserved administrative headroom (`DB_ADMIN_RESERVED_CONNECTIONS`, default `5`)
exceeds `DB_CONNECTION_LIMIT`. Reduce replica counts or `DB_POOL_MAX`, or raise
the database limit, then restart.

## Service-Level Objectives

The following SLOs define the user-facing reliability targets for the three
critical flows. They are the source of truth for alert thresholds: every alert
below must reference one of these objectives, and no alert may use a threshold
that is not derived from a documented SLO.

### SLIs and rolling windows

| Flow | SLI | Definition | Rolling window | Objective |
| --- | --- | --- | --- | --- |
| Registration | Availability | Proportion of `POST /register` (and `POST /register/confirm`) requests that return a non-5xx response | 28 days | 99.9% |
| Registration | Latency | Proportion of successful registration requests completing in under 1s | 28 days | 99% |
| Federation lookup | Availability | Proportion of `GET /federation/lookup` requests that return a non-5xx response | 28 days | 99.95% |
| Federation lookup | Latency | Proportion of successful federation lookups completing in under 300ms | 28 days | 99% |
| Payment flow | Availability | Proportion of payment intent create/confirm requests that return a non-5xx response | 28 days | 99.9% |
| Payment flow | Latency | Proportion of successful payment requests completing in under 2s | 28 days | 99% |

Short-window burn-rate alerts use 1h and 6h windows over the same SLIs so that
fast regressions page before the 28-day budget is materially consumed.

### Exclusions

The following requests are excluded from SLI computation and must be filtered
out in every recording rule and alert expression:

- Requests rejected by the edge with 4xx client errors (validation, auth,
  rate limiting) — these are user errors, not service failures.
- Health, readiness, and metrics endpoints (`/health`, `/ready`, `/metrics`).
- Synthetic probe traffic tagged `probe="synthetic"`.
- Planned maintenance windows announced in advance and recorded in the
  incident log.

Exclusions are applied by metric label filters only; no user identifiers are
used to exclude traffic.

### Error-budget rules

- Each flow has a 28-day error budget of `1 - objective` of its total valid
  requests.
- **Page** when the 1h burn rate exceeds 14.4x (2% of the 28-day budget in one
  hour) or the 6h burn rate exceeds 6x.
- **Ticket** when the 6h burn rate exceeds 1x (budget on pace to exhaust within
  the window).
- When a flow's budget is exhausted, feature work for that flow is frozen until
  the budget recovers above 25% remaining; the freeze is lifted by the owner.
- Budget consumption is reviewed weekly by the owning team.

### Named ownership

| Flow | Owning team | Escalation |
| --- | --- | --- |
| Registration | Identity & Onboarding | `#identity-oncall` |
| Federation lookup | Platform / Federation | `#platform-oncall` |
| Payment flow | Payments | `#payments-oncall` |

Each SLO has a named owner responsible for reviewing burn-rate alerts,
maintaining the recording rules, and approving exclusions.

## Ledger Confirmation Lag and Reconciliation Backlog

### Metrics

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `stellar_tags_ledger_submission_to_finality_seconds` | histogram | `network`, `operation` | Time from transaction submission to ledger finality. |
| `stellar_tags_reconciliation_oldest_unreconciled_intent_age_seconds` | gauge | `network` | Age of the oldest payment intent not yet reconciled, per network. |

Percentiles are computed with `histogram_quantile` over the histogram; the
backlog age is read directly from the gauge.

### Alert thresholds

Thresholds are tied to the payment-flow SLO (99% of payments under 2s) and the
documented reconciliation objective (all intents reconciled within 15 minutes).

| Alert | Expression | For | Severity |
| --- | --- | --- | --- |
| Ledger finality p99 high | `histogram_quantile(0.99, sum by (le, network) (rate(stellar_tags_ledger_submission_to_finality_seconds_bucket[5m]))) > 30` | 10m | page |
| Ledger finality p95 degraded | `histogram_quantile(0.95, sum by (le, network) (rate(stellar_tags_ledger_submission_to_finality_seconds_bucket[5m]))) > 10` | 15m | ticket |
| Reconciliation backlog age | `stellar_tags_reconciliation_oldest_unreconciled_intent_age_seconds > 900` | 10m | page |
| Reconciliation backlog growing | `deriv(stellar_tags_reconciliation_oldest_unreconciled_intent_age_seconds[10m]) > 0` | 20m | ticket |

### Label hygiene

- Labels are limited to low-cardinality dimensions: `network`, `operation`,
  `status_code`, `route`, and `probe`. Never add user identifiers (account,
  public key, email, intent id, transaction hash) as labels.
- Per-intent or per-transaction detail belongs in logs and traces, correlated
  by trace id, not in metric labels.
- New labels must be reviewed by the owning team and documented in this file
  before being added to any recording rule or alert.


- **Connection Pool Exhaustion**: Alert when
=======
## Canary Rollout Dashboard

The canary rollout panels visualize the health of a canary deployment against
its stable baseline and show whether the automated rollback gates have halted
promotion. They are imported with the same dashboard JSON and the same
`${DS_PROMETHEUS}` datasource input as the panels above.

### Canary Panels

| Panel | Metric | Description |
| --- | --- | --- |
| Canary Traffic Share | `stellar_tags_canary_traffic_share` | Fraction of eligible requests routed to the canary, by `stage`. Compare against the configured stage weight. |
| Canary Error Rate | `stellar_tags_canary_requests_total` | Error ratio per `variant` (`stable`, `canary`), computed over the evaluation window. Yellow at the policy warning threshold, red at the rollback threshold. |
| Canary Latency (p95 / p99) | `stellar_tags_canary_request_duration_seconds` | Histogram quantiles per `variant` and `route`, over the evaluation window. Yellow at the warning threshold, red at the rollback threshold. |
| Gate Evaluation Result | `stellar_tags_canary_gate_evaluations_total` | Count of gate evaluations by `result` (`pass`, `fail`) and `gate` (`error_rate`, `latency`). |
| Rollback Events | `stellar_tags_canary_rollbacks_total` | Count of automated and manual rollbacks by `trigger` (`error_rate`, `latency`, `manual`). |
| Manual Overrides | `stellar_tags_canary_overrides_total` | Count of audited manual promote/halt/rollback overrides by `action` and `actor`. |

### Using the panels during a rollout

1. **Before promotion**: confirm the canary is receiving the expected traffic
   share for the current stage and that the error-rate and latency panels are
   below their warning thresholds for at least one full evaluation window.
2. **During the evaluation window**: watch the gate evaluation panel. A `fail`
   result halts promotion automatically; the rollback panel increments when the
   canary is rolled back. Do not manually promote while a gate is failing.
3. **After a rollback**: the rollback event and the triggering gate identify
   which indicator breached policy. Correlate with logs and traces by trace id
   before re-attempting the rollout.
4. **Manual overrides**: any promote, halt, or rollback performed by an operator
   is recorded in the manual overrides panel with the acting identity. Overrides
   are audited; use them only to stop a rollout, never to bypass a failing gate.

## Alerting Suggestions

Create Grafana alerts on the following to catch pool exhaustion early:

- **Connection Pool Exhaustion**: Alert when
=======

- **Connection Pool Exhaustion**: Alert when
  `stellar_tags_db_pool_connections_busy / stellar_tags_db_pool_connections_open > 0.8`
  for 5 minutes.
- **Queued Queries**: Alert when `stellar_tags_db_pool_queries_waiting > 0`
  for 2 minutes.
- **Redis Down**: Alert when `stellar_tags_redis_connections_active == 0` for
  1 minute.
