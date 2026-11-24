# Grafana Alerting: Stellar Tags Operational Alerts

This document explains how to import and configure the Stellar Tags operational alerts in Grafana:

- `StellarTagsDBPoolWaiting` — database connection pool saturation.
- `StellarTagsLedgerConfirmationLag` — submission-to-finality latency above the documented objective.
- `StellarTagsReconciliationBacklog` — oldest unreconciled intent age above the documented objective.

## Label Hygiene (applies to every alert)

Alert labels are used for routing, grouping and silencing, and they are frequently forwarded to third-party contact points. **Labels must never contain user identifiers** (account IDs, public keys, intent IDs, transaction hashes, request IDs, emails, IP addresses, or any other value that can be tied to a user). Only bounded, low-cardinality operational dimensions are allowed as labels, for example:

- `severity` (`warning`, `critical`)
- `component` (`database`, `ledger`, `reconciliation`)
- `network` (`mainnet`, `testnet`, `futurenet`, ...)

Per-network series are distinguished by the `network` label only; the network value comes from configuration, not from request data. Any value that varies per user or per intent (e.g. the specific intent that is oldest) belongs in **annotations** (description/summary), not in labels, and annotations must be reviewed before being routed externally. If you add a label, confirm it is drawn from a fixed, documented set of values.

## Alert Overview

| Property | Value |
| --- | --- |
| Alert name | `StellarTagsDBPoolWaiting` |
| Metric | `stellar_tags_db_pool_queries_waiting` |
| Condition | `> 5` |
| Duration (`for`) | `30s` |
| Severity | `warning` |
| Summary | DB pool saturation: queries are waiting for a free connection |

The metric `stellar_tags_db_pool_queries_waiting` is a gauge that tracks the number of queries currently waiting for a free connection from the database pool. A sustained value above `5` indicates pool saturation and imminent query timeouts.

## Option 1: Import the Prometheus Alerting Rule

The canonical rule definition lives in [`docs/prometheus-alerts.yml`](./prometheus-alerts.yml). If you run Prometheus with Grafana, load the rule file into Prometheus and let Grafana display the resulting alerts.

### 1. Load the rule into Prometheus

Add the rule file to your Prometheus configuration:

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/prometheus-alerts.yml
```

Copy `docs/prometheus-alerts.yml` to the path referenced above (e.g. `/etc/prometheus/rules/prometheus-alerts.yml`) and reload Prometheus:

```bash
curl -X POST http://localhost:9090/-/reload
```

Verify the rule is loaded under **Status → Rules** in the Prometheus UI.

### 2. Add Prometheus as a Grafana data source

1. In Grafana, go to **Connections → Data sources → Add data source**.
2. Select **Prometheus**.
3. Set the URL to your Prometheus server (e.g. `http://prometheus:9090`).
4. Click **Save & test**.

### 3. View the alert in Grafana

Once Prometheus evaluates the rule, the alert appears in Grafana under **Alerting → Alert rules** (grouped by the Prometheus data source) and in **Alerting → Alert groups**. Firing alerts are visible in the **Alerting** view and can be routed to contact points as described below.

## Option 2: Create a Grafana-Managed Alert

If you prefer Grafana to evaluate the alert directly (no Prometheus rule file required), create a Grafana-managed alert rule.

### 1. Create the alert rule

1. Go to **Alerting → Alert rules → New alert rule**.
2. **Rule name:** `StellarTagsDBPoolWaiting`
3. **Folder:** choose or create a folder (e.g. `Stellar Tags`).
4. **Evaluation group:** create a group (e.g. `stellar-tags-db`) with an evaluation interval of `10s` (must be shorter than the `30s` duration).
5. **Data source:** select your Prometheus data source.
6. **Query:** enter the following PromQL:

   ```promql
   stellar_tags_db_pool_queries_waiting
   ```

7. **Condition:** set the reducer to **Last** and the threshold to **Is above** `5`.
8. **Pending period:** set to `30s` (equivalent to the Prometheus `for: 30s`).
9. **Labels:** add `severity: warning` and `component: database`.
10. **Annotations:**
    - **Summary:** `DB pool saturation: queries are waiting for a free connection`
    - **Description:** `stellar_tags_db_pool_queries_waiting is {{ $values.A.Value }} (threshold 5) for more than 30s.`
11. Click **Save rule and exit**.

### 2. Equivalent PromQL (for reference)

The rule fires when the gauge exceeds `5` for more than `30s`:

```promql
stellar_tags_db_pool_queries_waiting > 5
```

## Alert: `StellarTagsLedgerConfirmationLag`

This alert fires when the submission-to-finality latency (time from intent submission to ledger finality) exceeds the documented objective for a network. Percentiles are computed from the `stellar_tags_ledger_confirmation_seconds` histogram (submission-to-finality duration in seconds), labelled by `network`.

| Property | Value |
| --- | --- |
| Alert name | `StellarTagsLedgerConfirmationLag` |
| Metric | `stellar_tags_ledger_confirmation_seconds` (histogram) |
| Condition | p95 submission-to-finality `> 30s` for `10m` |
| Duration (`for`) | `10m` |
| Severity | `warning` |
| Summary | Ledger confirmation lag: p95 submission-to-finality exceeds the 30s objective |

The thresholds are derived from the documented objectives: the p95 submission-to-finality objective is **30 seconds** per network, and the p99 objective is **60 seconds**. The warning alert tracks the p95 objective; the critical alert tracks the p99 objective. Both are evaluated per `network` so a single degraded network does not mask a healthy one.

### PromQL

```promql
# Warning: p95 submission-to-finality above the 30s objective for 10m
histogram_quantile(
  0.95,
  sum by (network, le) (rate(stellar_tags_ledger_confirmation_seconds_bucket[5m]))
) > 30

# Critical: p99 submission-to-finality above the 60s objective for 10m
histogram_quantile(
  0.99,
  sum by (network, le) (rate(stellar_tags_ledger_confirmation_seconds_bucket[5m]))
) > 60
```

### Grafana-managed rule

1. **Rule name:** `StellarTagsLedgerConfirmationLag`
2. **Folder:** `Stellar Tags`
3. **Evaluation group:** `stellar-tags-ledger`, evaluation interval `1m`.
4. **Query:** the warning PromQL above (or the critical variant, as a separate rule).
5. **Condition:** **Is above** `30` (warning) or `60` (critical).
6. **Pending period:** `10m`.
7. **Labels:** `severity: warning` (or `critical`), `component: ledger`. Do **not** add per-network labels manually — the `network` label is produced by the query and is bounded to the configured networks.
8. **Annotations:**
   - **Summary:** `Ledger confirmation lag: p95 submission-to-finality exceeds the 30s objective`
   - **Description:** `network={{ $labels.network }} p95 submission-to-finality is {{ $values.A.Value }}s (objective 30s) for more than 10m.`

## Alert: `StellarTagsReconciliationBacklog`

This alert fires when the oldest unreconciled intent is older than the documented reconciliation objective for a network. The gauge `stellar_tags_reconciliation_oldest_unreconciled_seconds` reports the age in seconds of the oldest intent that has not yet been reconciled, labelled by `network`.

| Property | Value |
| --- | --- |
| Alert name | `StellarTagsReconciliationBacklog` |
| Metric | `stellar_tags_reconciliation_oldest_unreconciled_seconds` (gauge) |
| Condition | oldest unreconciled intent age `> 300s` for `10m` |
| Duration (`for`) | `10m` |
| Severity | `warning` |
| Summary | Reconciliation backlog: oldest unreconciled intent exceeds the 5m objective |

The threshold is derived from the documented objective: every intent should be reconciled within **5 minutes** (300 seconds) of finality. The warning alert fires at the objective; the critical alert fires at twice the objective (**10 minutes**), indicating a backlog that is not draining.

### PromQL

```promql
# Warning: oldest unreconciled intent older than the 5m objective for 10m
stellar_tags_reconciliation_oldest_unreconciled_seconds > 300

# Critical: oldest unreconciled intent older than 2x the objective for 10m
stellar_tags_reconciliation_oldest_unreconciled_seconds > 600
```

### Grafana-managed rule

1. **Rule name:** `StellarTagsReconciliationBacklog`
2. **Folder:** `Stellar Tags`
3. **Evaluation group:** `stellar-tags-reconciliation`, evaluation interval `1m`.
4. **Query:** the warning PromQL above (or the critical variant, as a separate rule).
5. **Condition:** **Is above** `300` (warning) or `600` (critical).
6. **Pending period:** `10m`.
7. **Labels:** `severity: warning` (or `critical`), `component: reconciliation`. Do **not** add intent IDs or account IDs as labels; the `network` label is the only per-series dimension.
8. **Annotations:**
   - **Summary:** `Reconciliation backlog: oldest unreconciled intent exceeds the 5m objective`
   - **Description:** `network={{ $labels.network }} oldest unreconciled intent age is {{ $values.A.Value }}s (objective 300s) for more than 10m.`

## Alert: `StellarTagsCanaryRolloutHalted`

This alert fires when the backend canary rollout controller halts promotion or triggers an automatic rollback because a user-visible indicator breached the canary policy. The controller exposes the following metrics, all labelled by `network` and `component` only (never by canary instance, request, or user identifiers):

| Metric | Type | Meaning |
| --- | --- | --- |
| `stellar_tags_canary_traffic_ratio` | gauge | Fraction of backend traffic currently routed to the canary (0–1). |
| `stellar_tags_canary_error_ratio` | gauge | Canary error ratio over the evaluation window (0–1). |
| `stellar_tags_canary_latency_p95_seconds` | gauge | Canary p95 request latency over the evaluation window. |
| `stellar_tags_canary_rollback_total` | counter | Automatic rollbacks triggered, by `reason` (`error_ratio`, `latency`, `manual`). |
| `stellar_tags_canary_state` | gauge | Current state: `0` = idle, `1` = promoting, `2` = halted, `3` = rolled back. |

| Property | Value |
| --- | --- |
| Alert name | `StellarTagsCanaryRolloutHalted` |
| Metric | `stellar_tags_canary_state` |
| Condition | state `== 2` (halted) or `== 3` (rolled back) for `1m` |
| Duration (`for`) | `1m` |
| Severity | `critical` |
| Summary | Canary rollout halted or rolled back: user-visible indicators breached policy |

### PromQL

```promql
# Halted or rolled back canary for 1m
stellar_tags_canary_state >= 2
```

### Grafana-managed rule

1. **Rule name:** `StellarTagsCanaryRolloutHalted`
2. **Folder:** `Stellar Tags`
3. **Evaluation group:** `stellar-tags-canary`, evaluation interval `30s`.
4. **Query:** the PromQL above.
5. **Condition:** **Is above** `1`.
6. **Pending period:** `1m`.
7. **Labels:** `severity: critical`, `component: canary`. Do **not** add canary instance IDs, deployment SHAs, or request identifiers as labels.
8. **Annotations:**
   - **Summary:** `Canary rollout halted or rolled back: user-visible indicators breached policy`
   - **Description:** `network={{ $labels.network }} canary state is {{ $values.A.Value }} (2=halted, 3=rolled back). Check stellar_tags_canary_rollback_total for the reason.`

## Canary Rollout Policy

The backend canary rollout is governed by a fixed policy. Promotion is **halted** and the canary is **automatically rolled back** whenever a user-visible indicator breaches a threshold during the evaluation window. The policy is:

| Parameter | Value | Notes |
| --- | --- | --- |
| Initial canary traffic | `5%` | First step after deploy. |
| Traffic steps | `5% → 25% → 50% → 100%` | Each step requires passing the evaluation window. |
| Evaluation window | `10m` per step | Minimum observation time before promotion. |
| Error ratio threshold | `> 1%` canary error ratio | Compared against the stable baseline; breaches halt promotion. |
| Latency threshold | canary p95 `> 1.25x` stable p95 (and `> 500ms` absolute) | Either condition breaches halt promotion. |
| Minimum sample size | `200` canary requests per window | Below this, the window is extended, not failed. |
| Automatic rollback | On any breach | Traffic returns to `0%` canary; the rollout is marked rolled back. |

### Interpreting canary alerts

- `StellarTagsCanaryRolloutHalted` firing with `stellar_tags_canary_state == 2` means promotion was **halted** (e.g. the window is still being evaluated or a breach was detected) but traffic has not yet been fully drained. Investigate `stellar_tags_canary_error_ratio` and `stellar_tags_canary_latency_p95_seconds` for the breaching indicator.
- Firing with `stellar_tags_canary_state == 3` means the canary was **automatically rolled back**. Inspect `stellar_tags_canary_rollback_total{reason=...}` to identify whether the error-ratio or latency gate tripped, then review the canary logs for the affected `network`.
- A canary that never advances past a step (state stays `1` with a flat `stellar_tags_canary_traffic_ratio`) usually indicates the minimum sample size was not reached; extend the observation window rather than overriding.

### Manual override (audited)

Operators may override a halted or rolled-back canary, but every override is **audited**. An override:

1. Requires an operator with the rollout-admin role.
2. Records the operator identity, timestamp, target state, and a mandatory justification in the audit log (the justification is free text and must not contain user identifiers).
3. Emits an audit event and increments `stellar_tags_canary_rollback_total{reason="manual"}` when the override forces a rollback.
4. Does **not** bypass the thresholds for subsequent steps — the policy re-applies at the next promotion.

To perform an override, use the rollout admin endpoint (see the backend API docs) with a justification; the request is rejected if the justification is missing or the caller lacks the role. Overrides are visible in the audit log and should be referenced in the incident record.

## Configure Notification Channels (Contact Points)

Notification delivery (Slack, PagerDuty, email, etc.) is an operator choice and is out of scope for the repository. To wire up notifications:

1. Go to **Alerting → Contact points → New contact point**.
2. Choose an integration type (e.g. Slack, PagerDuty, Email, Webhook) and fill in the required settings.
3. Go to **Alerting → Notification policies**.
4. Add a policy that matches the alert label `severity=warning` (or `alertname=StellarTagsDBPoolWaiting`) and routes it to the contact point created above.

## Testing the Alert

You can validate the rule with a mock time series before relying on it in production:

1. In Grafana **Explore**, select the Prometheus data source.
2. Run the query `stellar_tags_db_pool_queries_waiting` and confirm the metric is being scraped.
3. To simulate a firing alert, temporarily lower the threshold to `0` in a test copy of the rule, or use a recording rule / test exporter that emits a value above `5`.
4. Confirm the alert transitions to **Pending** and then **Firing** after `30s`.

For the ledger and reconciliation alerts, emit synthetic observations into a test instance: record `stellar_tags_ledger_confirmation_seconds` observations above `30` (and `60`) and set `stellar_tags_reconciliation_oldest_unreconciled_seconds` above `300` (and `600`), then confirm each alert transitions to **Pending** and then **Firing** after its `10m` pending period. Verify the resulting alert labels contain only `severity`, `component` and `network` — never a user identifier.

Alternatively, validate the Prometheus rule file with `promtool`:

```bash
promtool check rules docs/prometheus-alerts.yml
```

## Related Files

- [`docs/prometheus-alerts.yml`](./prometheus-alerts.yml) — Prometheus alerting rule definitions, including the ledger confirmation lag, reconciliation backlog, and canary rollout alerts.
- [`docs/grafana-dashboard.json`](./grafana-dashboard.json) — Grafana dashboard, including the embedded alert panel for this metric.
- [`README.md`](../README.md) — Monitoring section referencing the alert file.