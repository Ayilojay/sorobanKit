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

## Alerting Suggestions

Create Grafana alerts on the following to catch pool exhaustion early:

- **Connection Pool Exhaustion**: Alert when
  `stellar_tags_db_pool_connections_busy / stellar_tags_db_pool_connections_open > 0.8`
  for 5 minutes.
- **Queued Queries**: Alert when `stellar_tags_db_pool_queries_waiting > 0`
  for 2 minutes.
- **Redis Down**: Alert when `stellar_tags_redis_connections_active == 0` for
  1 minute.
