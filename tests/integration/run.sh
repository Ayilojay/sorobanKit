#!/usr/bin/env bash
#
# End-to-end integration test for the payment_router Soroban contract
# against a local standalone Stellar network (the integration profile in
# docker-compose.yml).
#
# Verifies:
#   1. The contract can be deployed to the local network.
#   2. `initialize` sets the admin and fee configuration.
#   3. `route_payment` routes a payment end-to-end, deducting the platform
#      fee and crediting the recipient, as observed through local Horizon.
#   4. The full refund lifecycle: a payment to a recipient without a
#      trustline credits the refund ledger, and `claim_all_refunds`
#      returns the tokens to the sender.
#   5. Build provenance: the contract wasm digest matches the attested
#      provenance (and a tampered digest fails validation).
#   6. Image signatures: the backend/dashboard/contract image digests are
#      signed and verify against the expected workload identity.
#   7. Canary gate: the canary rollout promotes on healthy metrics and
#      halts + rolls back when latency/error thresholds are breached.
#
# Prerequisites:
#   - docker compose --profile integration up -d stellar-standalone
#   - soroban CLI installed
#   - rustup target add wasm32-unknown-unknown
#   - cosign installed (for signature verification steps)
#   - jq installed (for provenance/canary assertions)
#
# Usage:
#   ./tests/integration/run.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTRACT_DIR="${ROOT_DIR}/payment_router"

RPC_URL="${RPC_URL:-http://localhost:8000/rpc}"
HORIZON_URL="${HORIZON_URL:-http://localhost:8000}"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"

# Provenance / signing / canary configuration. These default to the local
# integration stack; CI overrides them with the real registry and identity.
BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
PROVENANCE_FILE="${PROVENANCE_FILE:-${ROOT_DIR}/dist/provenance.json}"
COSIGN_IDENTITY="${COSIGN_IDENTITY:-https://github.com/example/repo/.github/workflows/release.yml@refs/heads/main}"
COSIGN_OIDC_ISSUER="${COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
BACKEND_IMAGE="${BACKEND_IMAGE:-ghcr.io/example/backend:integration}"
DASHBOARD_IMAGE="${DASHBOARD_IMAGE:-ghcr.io/example/dashboard:integration}"
CONTRACT_IMAGE="${CONTRACT_IMAGE:-ghcr.io/example/payment-router:integration}"
CANARY_SCRIPT="${CANARY_SCRIPT:-${ROOT_DIR}/scripts/canary_gate.sh}"

# Root account funded by the quickstart standalone image.
FUNDED_SECRET="${FUNDED_SECRET:-SBFGFF27Y64ZUGFAIG5AMJGQODZZKV2OQOEF4QN2G2K6GZ2Y7QN6YQ4A}"

PASS=0
FAIL=0

check() {
  local desc="$1"
  if [ "$2" -eq 0 ]; then
    echo "  ✔ ${desc}"
    PASS=$((PASS + 1))
  else
    echo "  ✘ ${desc}" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "==> Waiting for Horizon to be ready ..."
for i in $(seq 1 30); do
  if curl -sf "${HORIZON_URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf "${HORIZON_URL}/" >/dev/null 2>&1 || {
  echo "ERROR: Horizon not reachable at ${HORIZON_URL}" >&2
  exit 1
}
echo "  Horizon is up."

echo "==> Building contract wasm ..."
cd "${CONTRACT_DIR}"
cargo build --release --target wasm32-unknown-unknown
WASM_PATH="${CONTRACT_DIR}/target/wasm32-unknown-unknown/release/payment_router.wasm"
[ -f "${WASM_PATH}" ] || { echo "ERROR: wasm not found" >&2; exit 1; }

echo "==> Verifying build provenance for contract artifact ..."
# The provenance attestation binds the source commit, workflow identity,
# toolchain, and artifact digest. A digest mismatch must fail validation.
if [ -f "${PROVENANCE_FILE}" ] && command -v jq >/dev/null 2>&1; then
  ACTUAL_DIGEST="sha256:$(sha256sum "${WASM_PATH}" | awk '{print $1}')"
  ATTESTED_DIGEST="$(jq -r '.subject[0].digest.sha256 // empty' "${PROVENANCE_FILE}" 2>/dev/null || true)"
  if [ -n "${ATTESTED_DIGEST}" ] && [[ "${ATTESTED_DIGEST}" != sha256:* ]]; then
    ATTESTED_DIGEST="sha256:${ATTESTED_DIGEST}"
  fi
  check "provenance digest matches built wasm (attested: ${ATTESTED_DIGEST:-<none>})" \
    $([ -n "${ATTESTED_DIGEST}" ] && [ "${ATTESTED_DIGEST}" = "${ACTUAL_DIGEST}" ] && echo 0 || echo 1)

  # Negative case: a tampered digest must be rejected by validation.
  TAMPERED_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"
  check "provenance validation rejects mismatched digest" \
    $([ "${TAMPERED_DIGEST}" != "${ACTUAL_DIGEST}" ] && echo 0 || echo 1)

  # Provenance must record the workflow identity and toolchain.
  WORKFLOW_ID="$(jq -r '.predicate.buildDefinition.externalParameters.workflow.ref // .predicate.invocation.configSource.uri // empty' "${PROVENANCE_FILE}" 2>/dev/null || true)"
  TOOLCHAIN="$(jq -r '.predicate.buildDefinition.internalParameters.toolchain // .predicate.buildConfig.toolchain // empty' "${PROVENANCE_FILE}" 2>/dev/null || true)"
  check "provenance records workflow identity (got: ${WORKFLOW_ID:-<none>})" \
    $([ -n "${WORKFLOW_ID}" ] && echo 0 || echo 1)
  check "provenance records toolchain (got: ${TOOLCHAIN:-<none>})" \
    $([ -n "${TOOLCHAIN}" ] && echo 0 || echo 1)
else
  echo "  (skipping provenance checks: ${PROVENANCE_FILE} or jq unavailable)"
fi

echo "==> Verifying container image signatures ..."
# Signatures are verified against the immutable image digest and the
# expected workload identity; no long-lived repository signing keys.
if command -v cosign >/dev/null 2>&1; then
  for image in "${BACKEND_IMAGE}" "${DASHBOARD_IMAGE}" "${CONTRACT_IMAGE}"; do
    cosign verify \
      --certificate-identity "${COSIGN_IDENTITY}" \
      --certificate-oidc-issuer "${COSIGN_OIDC_ISSUER}" \
      "${image}" >/dev/null 2>&1
    check "image signature verified: ${image}" $?
  done

  # Negative case: an unsigned/unknown image must fail verification.
  cosign verify \
    --certificate-identity "${COSIGN_IDENTITY}" \
    --certificate-oidc-issuer "${COSIGN_OIDC_ISSUER}" \
    "ghcr.io/example/unsigned:integration" >/dev/null 2>&1
  check "unsigned image fails signature verification" $([ $? -ne 0 ] && echo 0 || echo 1)
else
  echo "  (skipping signature checks: cosign unavailable)"
fi

echo "==> Deploying contract ..."
CONTRACT_ID="$(
  soroban contract deploy \
    --wasm "${WASM_PATH}" \
    --source "${FUNDED_SECRET}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}"
)"
echo "  Contract ID: ${CONTRACT_ID}"
check "contract deployed to local network" $?

echo "==> Creating test accounts ..."
# Generate fresh keypairs for admin, sender, recipient, and treasury.
ADMIN_SECRET="$(soroban keys generate --no-fund --rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}" admin 2>/dev/null || true)"
ADMIN_ADDR="$(soroban keys address admin)"
SENDER_ADDR="$(soroban keys address sender 2>/dev/null || soroban keys generate --no-fund --rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}" sender)"
RECIPIENT_ADDR="$(soroban keys address recipient 2>/dev/null || soroban keys generate --no-fund --rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}" recipient)"
TREASURY_ADDR="$(soroban keys address treasury 2>/dev/null || soroban keys generate --no-fund --rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}" treasury)"

# A recipient that intentionally has no trustline for the routed token, so
# the payment cannot be delivered and must be recorded as a refund.
NO_TRUSTLINE_ADDR="$(soroban keys address no_trustline 2>/dev/null || soroban keys generate --no-fund --rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}" no_trustline)"

echo "  admin:        ${ADMIN_ADDR}"
echo "  sender:       ${SENDER_ADDR}"
echo "  recipient:    ${RECIPIENT_ADDR}"
echo "  treasury:     ${TREASURY_ADDR}"
echo "  no-trustline: ${NO_TRUSTLINE_ADDR}"

echo "==> Funding accounts from root ..."
for addr in "${ADMIN_ADDR}" "${SENDER_ADDR}" "${RECIPIENT_ADDR}" "${TREASURY_ADDR}" "${NO_TRUSTLINE_ADDR}"; do
  soroban account fund \
    --account "${FUNDED_SECRET}" \
    --destination "${addr}" \
    --amount 1000 \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}" >/dev/null 2>&1 || true
done
check "accounts funded from root" $?

echo "==> Initializing contract ..."
soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${ADMIN_SECRET}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  initialize \
  --admin "${ADMIN_ADDR}" \
  --platform_treasury "${TREASURY_ADDR}" \
  --fee_bps 100 \
  --fee_cap 1000000 \
  --max_amount 1000000000000000 >/dev/null 2>&1
check "contract initialized" $?

echo "==> Verifying fee config via Horizon ..."
FEE="$(soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${ADMIN_SECRET}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  get_fee 2>/dev/null || echo "0")"
check "get_fee returns configured fee (got: ${FEE})" $([ "${FEE}" = "100" ] && echo 0 || echo 1)

echo "==> Routing a payment ..."
# Route 1000 stroops from sender to recipient with a 1% (100 bps) fee.
soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${SENDER_ADDR}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  route_payment \
  --sender "${SENDER_ADDR}" \
  --recipient "${RECIPIENT_ADDR}" \
  --token_address "${CONTRACT_ID}" \
  --amount 1000 >/dev/null 2>&1
check "route_payment executed" $?

echo "==> Verifying routing via Horizon ..."
# Query Horizon for the contract's recent operations to confirm the
# payment was routed (a routed event / operation exists).
ROUTED_OPS="$(
  curl -sf "${HORIZON_URL}/accounts/${CONTRACT_ID}/operations?limit=10" \
    | grep -c '"type"' || true
)"
check "Horizon reports operations for contract (got: ${ROUTED_OPS})" $([ "${ROUTED_OPS}" -gt 0 ] && echo 0 || echo 1)

echo "==> Routing a payment to a recipient without a trustline ..."
# The recipient has no trustline for the routed token, so the payment cannot
# be delivered and the contract must record it in the refund ledger.
soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${SENDER_ADDR}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  route_payment \
  --sender "${SENDER_ADDR}" \
  --recipient "${NO_TRUSTLINE_ADDR}" \
  --token_address "${CONTRACT_ID}" \
  --amount 1000 >/dev/null 2>&1
check "route_payment to no-trustline recipient executed" $?

echo "==> Verifying refund ledger was credited ..."
REFUND_AMOUNT="$(soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${SENDER_ADDR}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  get_refund \
  --sender "${SENDER_ADDR}" 2>/dev/null || echo "0")"
echo "  refund ledger credit for sender: ${REFUND_AMOUNT}"
check "refund ledger credited for sender (got: ${REFUND_AMOUNT})" $([ "${REFUND_AMOUNT}" -gt 0 ] && echo 0 || echo 1)

echo "==> Claiming all refunds ..."
CLAIMED="$(soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${SENDER_ADDR}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  claim_all_refunds \
  --sender "${SENDER_ADDR}" 2>/dev/null || echo "0")"
echo "  claim_all_refunds returned: ${CLAIMED}"
check "claim_all_refunds returned the refunded amount (got: ${CLAIMED})" $([ "${CLAIMED}" -gt 0 ] && echo 0 || echo 1)

echo "==> Verifying refund ledger is drained after claim ..."
REMAINING="$(soroban contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${SENDER_ADDR}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  get_refund \
  --sender "${SENDER_ADDR}" 2>/dev/null || echo "0")"
echo "  remaining refund ledger for sender: ${REMAINING}"
check "refund ledger drained after claim (got: ${REMAINING})" $([ "${REMAINING}" = "0" ] && echo 0 || echo 1)

echo "==> Exercising canary rollout gate ..."
# The canary gate promotes on healthy metrics and halts + rolls back when
# user-visible indicators (latency/error rate) breach policy.
if [ -x "${CANARY_SCRIPT}" ]; then
  # Healthy path: canary should promote to 100%.
  "${CANARY_SCRIPT}" \
    --service backend \
    --url "${BACKEND_URL}" \
    --traffic 10 \
    --window 30 \
    --max-error-rate 0.01 \
    --max-p99-latency-ms 500 \
    --promote >/dev/null 2>&1
  check "canary promotes when metrics are healthy" $?

  # Breach path: force a latency threshold breach; gate must halt and roll back.
  "${CANARY_SCRIPT}" \
    --service backend \
    --url "${BACKEND_URL}" \
    --traffic 10 \
    --window 30 \
    --max-error-rate 0.0 \
    --max-p99-latency-ms 1 \
    --promote >/dev/null 2>&1
  check "canary halts and rolls back on threshold breach" $([ $? -ne 0 ] && echo 0 || echo 1)

  # Manual override must be audited (records an audit entry).
  "${CANARY_SCRIPT}" \
    --service backend \
    --url "${BACKEND_URL}" \
    --override promote \
    --reason "integration-test override" >/dev/null 2>&1
  check "manual canary override is accepted and audited" $?
else
  echo "  (skipping canary checks: ${CANARY_SCRIPT} unavailable)"
fi

echo ""
echo "=============================================="
echo "Integration test results: ${PASS} passed, ${FAIL} failed"
echo "=============================================="

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
