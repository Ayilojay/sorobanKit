# Project

## Reporting read model

Aggregate statistics are served from a refreshable reporting read model rather than
being computed inline on the payment write path. This keeps reporting/aggregation
work from blocking payment writes.

### How it works

- Aggregates are materialized (or incrementally maintained) in the reporting read
  model, decoupled from payment writes.
- Each refresh records a **source watermark** (the point in the source data the
  aggregates were computed up to) and a **refresh status** (e.g. `idle`,
  `refreshing`, `succeeded`, `failed`) so consumers can tell how fresh the
  aggregates are.
- Refreshes run asynchronously, so payment writes are never blocked by
  aggregation work.

### Correctness

Aggregates in the read model can be verified against direct source queries. A
correctness check recomputes the expected values from the source data and
compares them to the read model for the same watermark, surfacing any drift.

### Refreshing

Trigger a refresh to bring the read model up to date with the source. The refresh
updates the watermark and status on completion; on failure the status reflects the
failure and the previous watermark is retained so the refresh can be retried.
