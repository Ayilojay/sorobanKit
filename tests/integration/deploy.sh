#!/usr/bin/env bash
#
# Deploys the payment_router Soroban contract to the local standalone
# Stellar network started by docker-compose.yml's integration profile.
#
# Prerequisites:
#   - Docker running with the standalone network up:
#       docker compose --profile integration up -d stellar-standalone
#   - The `soroban` CLI installed (https://soroban.stellar.org/docs/reference/cli)
#   - Rust toolchain with the `wasm32-unknown-unknown` target:
#       rustup target add wasm32-unknown-unknown
#
# Before deploying, this script verifies the supply-chain guarantees the
# release pipeline publishes (see docs/supply-chain.md):
#   1. Build provenance for the contract wasm (SLSA attestation) matches the
#      current source commit and the wasm digest.
#   2. The container images used by the integration profile are signed and
#      their signatures verify against the expected workload identity.
# Any mismatch aborts the deploy before the contract is submitted.
#
# Outputs the deployed contract ID to stdout and writes it to
# tests/integration/.contract-id so the integration test can read it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTRACT_DIR="${ROOT_DIR}/payment_router"

# Expected signer identity for image signatures (workload identity, not a
# long-lived key). Override for forks or local mirrors.
IMAGE_SIGNER_IDENTITY="${IMAGE_SIGNER_IDENTITY:-https://github.com/stellar/payment-router/.github/workflows/release.yml@refs/heads/main}"
IMAGE_SIGNER_ISSUER="${IMAGE_SIGNER_ISSUER:-https://token.actions.githubusercontent.com}"

# Images pulled by the integration profile that must be signed.
INTEGRATION_IMAGES=(
  "${STELLAR_IMAGE:-stellar/quickstart:testing}"
)

# Provenance attestation for the contract wasm. When unset, provenance is
# fetched from the release workflow's attestation bundle.
PROVENANCE_BUNDLE="${PROVENANCE_BUNDLE:-${ROOT_DIR}/dist/payment_router.provenance.jsonl}"
EXPECTED_SOURCE_COMMIT="${EXPECTED_SOURCE_COMMIT:-$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Verifies the wasm digest against the published provenance attestation and
# checks the attestation binds the expected source commit.
verify_provenance() {
  local wasm_path="$1"
  local actual_digest
  actual_digest="$(sha256_of "${wasm_path}")"

  if [ ! -f "${PROVENANCE_BUNDLE}" ]; then
    fail "provenance bundle not found at ${PROVENANCE_BUNDLE}; run the release workflow or set PROVENANCE_BUNDLE"
  fi

  if ! command -v cosign >/dev/null 2>&1; then
    fail "cosign is required to verify provenance; see docs/supply-chain.md"
  fi

  echo "==> Verifying build provenance for ${wasm_path} ..."
  if ! cosign verify-blob-attestation \
      --bundle "${PROVENANCE_BUNDLE}" \
      --type slsaprovenance \
      --certificate-identity "${IMAGE_SIGNER_IDENTITY}" \
      --certificate-oidc-issuer "${IMAGE_SIGNER_ISSUER}" \
      "${wasm_path}" >/dev/null; then
    fail "provenance signature verification failed for ${wasm_path}"
  fi

  local attested_digest
  attested_digest="$(
    cosign verify-blob-attestation \
      --bundle "${PROVENANCE_BUNDLE}" \
      --type slsaprovenance \
      --certificate-identity "${IMAGE_SIGNER_IDENTITY}" \
      --certificate-oidc-issuer "${IMAGE_SIGNER_ISSUER}" \
      --output json "${wasm_path}" 2>/dev/null \
      | grep -o '"subject_sha256":"[a-f0-9]*"' \
      | head -n1 | cut -d'"' -f4
  )"

  if [ -z "${attested_digest}" ]; then
    fail "could not extract attested digest from ${PROVENANCE_BUNDLE}"
  fi
  if [ "${attested_digest}" != "${actual_digest}" ]; then
    fail "digest mismatch: wasm is ${actual_digest} but provenance attests ${attested_digest}"
  fi

  if ! grep -q "\"source_commit\":\"${EXPECTED_SOURCE_COMMIT}\"" "${PROVENANCE_BUNDLE}"; then
    fail "provenance does not bind source commit ${EXPECTED_SOURCE_COMMIT}"
  fi

  echo "    provenance OK (digest ${actual_digest}, commit ${EXPECTED_SOURCE_COMMIT})"
}

# Verifies each integration image is signed by the expected workload identity.
verify_image_signatures() {
  if ! command -v cosign >/dev/null 2>&1; then
    fail "cosign is required to verify image signatures; see docs/supply-chain.md"
  fi

  local image
  for image in "${INTEGRATION_IMAGES[@]}"; do
    echo "==> Verifying signature for image ${image} ..."
    if ! cosign verify \
        --certificate-identity "${IMAGE_SIGNER_IDENTITY}" \
        --certificate-oidc-issuer "${IMAGE_SIGNER_ISSUER}" \
        "${image}" >/dev/null; then
      fail "image signature verification failed for ${image}"
    fi
  done
}

# Standalone network RPC endpoint exposed by the quickstart container.
RPC_URL="${RPC_URL:-http://localhost:8000/rpc}"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"

# Well-known funded account on the standalone network (root account).
# The quickstart image funds this account with a large XLM balance.
FUNDED_SECRET="${FUNDED_SECRET:-SBFGFF27Y64ZUGFAIG5AMJGQODZZKV2OQOEF4QN2G2K6GZ2Y7QN6YQ4A}"

echo "==> Building payment_router contract (release wasm) ..."
cd "${CONTRACT_DIR}"
cargo build --release --target wasm32-unknown-unknown

WASM_PATH="${CONTRACT_DIR}/target/wasm32-unknown-unknown/release/payment_router.wasm"
if [ ! -f "${WASM_PATH}" ]; then
  echo "ERROR: wasm not found at ${WASM_PATH}" >&2
  exit 1
fi

# Supply-chain gates: fail fast before any network mutation.
verify_provenance "${WASM_PATH}"
verify_image_signatures

echo "==> Deploying contract to standalone network ..."
CONTRACT_ID="$(
  soroban contract deploy \
    --wasm "${WASM_PATH}" \
    --source "${FUNDED_SECRET}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}"
)"

echo "Contract deployed: ${CONTRACT_ID}"
echo "${CONTRACT_ID}" > "${SCRIPT_DIR}/.contract-id"

echo "==> Done. Contract ID written to tests/integration/.contract-id"
