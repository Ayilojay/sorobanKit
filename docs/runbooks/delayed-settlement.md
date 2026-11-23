# Delayed Settlement Runbook

## Overview

This runbook covers procedures for diagnosing and resolving delayed settlement events in the payment system. Delayed settlement occurs when payments are authorized but not settled within the expected timeframe.

**Severity:** P1 (Critical) if settlement delay exceeds 4 hours; P2 (High) if delay exceeds 1 hour.

**Owner:** Payments Platform Team
**Last Reviewed:** 2024-01-15
**Review Cadence:** Quarterly

## Symptoms

- Settlement batch jobs report incomplete or failed status
- Payment records stuck in `AUTHORIZED` or `PENDING_SETTLEMENT` state beyond SLA
- Settlement reconciliation reports show mismatched totals
- Customer reports of funds not received
- Alerts firing: `SettlementDelayHigh`, `SettlementBatchFailed`, `ReconciliationMismatch`

## Diagnostics

### 1. Check settlement service health

```bash
# Verify settlement service is running
kubectl get pods -n payments -l app=settlement-service

# Check recent logs for errors
kubectl logs -n payments -l app=settlement-service --tail=200 --since=1h | grep -i error

# Check service endpoints
curl -sf http://settlement-service.payments.svc.cluster.local:8080/healthz
curl -sf http://settlement-service.payments.svc.cluster.local:8080/readyz
```

### 2. Inspect settlement queue depth

```bash
# Check pending settlement queue
curl -sf http://settlement-service.payments.svc.cluster.local:8080/metrics | grep settlement_queue_depth

# Check batch job status
kubectl get jobs -n payments -l app=settlement-batch --sort-by=.metadata.creationTimestamp
```

### 3. Query database for stuck settlements

```bash
# Count payments stuck in settlement states
psql "$DATABASE_URL" -c "
  SELECT status, COUNT(*), MIN(updated_at) AS oldest
  FROM payments
  WHERE status IN ('AUTHORIZED', 'PENDING_SETTLEMENT')
    AND updated_at < NOW() - INTERVAL '1 hour'
  GROUP BY status;
"
```

### 4. Verify downstream settlement provider connectivity

```bash
# Check provider connectivity
curl -sf -o /dev/null -w "%{http_code}\n" https://api.settlement-provider.example.com/health

# Check recent provider API errors
kubectl logs -n payments -l app=settlement-service --since=30m | grep -i "provider" | grep -i "error"
```

## Dashboards and Alerts

- **Settlement Overview Dashboard:** https://grafana.example.com/d/settlement-overview
- **Payment Pipeline Dashboard:** https://grafana.example.com/d/payment-pipeline
- **Settlement Queue Alert:** https://grafana.example.com/alerting/settlement-queue-depth
- **Reconciliation Dashboard:** https://grafana.example.com/d/reconciliation
- **PagerDuty Service:** https://example.pagerduty.com/service/payments-platform

## Escalation

1. **T+0 min:** On-call engineer acknowledges alert and begins diagnostics.
2. **T+15 min:** If unresolved, escalate to Payments Platform secondary on-call.
3. **T+30 min:** Notify Payments Platform Team Lead and open incident channel `#inc-payments-settlement`.
4. **T+60 min:** Engage Settlement Provider support and notify Finance Operations.
5. **T+4 hours:** Escalate to Engineering Director and initiate customer communications.

**Contacts:**
- Payments Platform on-call: PagerDuty `payments-platform`
- Settlement Provider support: `support@settlement-provider.example.com`
- Finance Operations: `finops@example.com`

## Rollback

If a recent deployment caused the delay:

```bash
# Check recent deployments
kubectl rollout history deployment/settlement-service -n payments

# Roll back to previous version
kubectl rollout undo deployment/settlement-service -n payments

# Verify rollback
kubectl rollout status deployment/settlement-service -n payments
```

If a configuration change caused the delay:

```bash
# Revert settlement configuration
kubectl get configmap settlement-config -n payments -o yaml > /tmp/settlement-config-backup.yaml
kubectl apply -f config/settlement-config-previous.yaml -n payments

# Restart service to pick up config
kubectl rollout restart deployment/settlement-service -n payments
```

## Recovery Verification

After applying a fix, verify recovery:

```bash
# 1. Confirm service health
curl -sf http://settlement-service.payments.svc.cluster.local:8080/healthz

# 2. Confirm queue is draining
curl -sf http://settlement-service.payments.svc.cluster.local:8080/metrics | grep settlement_queue_depth

# 3. Confirm no stuck settlements remain
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM payments
  WHERE status IN ('AUTHORIZED', 'PENDING_SETTLEMENT')
    AND updated_at < NOW() - INTERVAL '1 hour';
"

# 4. Run reconciliation check
curl -sf -X POST http://settlement-service.payments.svc.cluster.local:8080/admin/reconcile

# 5. Verify batch job completes
kubectl get jobs -n payments -l app=settlement-batch --sort-by=.metadata.creationTimestamp | tail -5
```

**Recovery criteria:**
- Settlement queue depth returns to baseline (< 100)
- No payments stuck beyond SLA
- Reconciliation reports zero mismatches
- All alerts resolved

## Post-Incident

- File incident report within 48 hours
- Update this runbook with any new findings
- Add monitoring/alerting for newly discovered failure modes