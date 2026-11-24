#!/usr/bin/env bash
#
# generate-sbom.sh - Generate a CycloneDX JSON SBOM for a releasable artifact.
#
# Supports three artifact types:
#   node       - Node.js project, uses @cyclonedx/cyclonedx-npm against package-lock.json
#   rust       - Rust project (payment_router), uses cargo-cyclonedx or cargo-sbom
#   container  - Container image, uses syft against the image digest
#
# The generated SBOM embeds the source revision (git SHA) and the artifact
# digest in its metadata (component properties). A companion manifest JSON is
# written alongside the SBOM linking the SBOM file, format, source revision,
# and artifact digest.
#
# A build provenance attestation (in-toto statement, SLSA-style) is also
# written to <artifact>.provenance.json. It binds the artifact subject digest,
# source revision, workflow identity (from GITHUB_WORKFLOW_REF /
# GITHUB_REPOSITORY / GITHUB_RUN_* when available), and toolchain versions.
# The manifest records the provenance file path and digest.
#
# Usage:
#   scripts/generate-sbom.sh --type <node|rust|container> \
#                            --revision <git-sha> \
#                            --digest <artifact-digest> \
#                            [--output-dir <dir>] \
#                            [--name <artifact-name>] \
#                            [--image <image-ref>] \
#                            [--project-dir <dir>] \
#                            [--provenance | --no-provenance]
#
# Options:
#   --type         Artifact type: node, rust, or container (required)
#   --revision     Source revision (git commit SHA) (required)
#   --digest       Artifact digest (e.g. sha256:...) (required)
#   --output-dir   Directory to write SBOM and manifest (default: ./sbom)
#   --name         Artifact name used in file names and metadata
#                  (default: derived from type)
#   --image        Container image reference (required for --type container)
#   --project-dir  Project directory (default: repo root for node/rust)
#   --provenance   Emit <artifact>.provenance.json (default: enabled)
#   --no-provenance  Skip provenance attestation generation
#   -h, --help     Show this help
#
# Exit codes:
#   0  success
#   1  usage error
#   2  missing dependency / tool error
#   3  generation failure
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARTIFACT_TYPE=""
SOURCE_REVISION=""
ARTIFACT_DIGEST=""
OUTPUT_DIR="${REPO_ROOT}/sbom"
ARTIFACT_NAME=""
IMAGE_REF=""
PROJECT_DIR=""
EMIT_PROVENANCE=1

log() { printf '[generate-sbom] %s\n' "$*" >&2; }
die() { printf '[generate-sbom] ERROR: %s\n' "$*" >&2; exit "${2:-3}"; }

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    die "required command not found: ${cmd}" 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)        ARTIFACT_TYPE="${2:-}"; shift 2 ;;
    --revision)    SOURCE_REVISION="${2:-}"; shift 2 ;;
    --digest)      ARTIFACT_DIGEST="${2:-}"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="${2:-}"; shift 2 ;;
    --name)        ARTIFACT_NAME="${2:-}"; shift 2 ;;
    --image)       IMAGE_REF="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --provenance)  EMIT_PROVENANCE=1; shift ;;
    --no-provenance) EMIT_PROVENANCE=0; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown argument: $1" 1 ;;
  esac
done

# --- Validate inputs ---------------------------------------------------------

case "${ARTIFACT_TYPE}" in
  node|rust|container) ;;
  "") die "--type is required (node|rust|container)" 1 ;;
  *)  die "invalid --type '${ARTIFACT_TYPE}' (expected node|rust|container)" 1 ;;
esac

[[ -n "${SOURCE_REVISION}" ]] || die "--revision is required" 1
[[ -n "${ARTIFACT_DIGEST}" ]] || die "--digest is required" 1

if [[ "${ARTIFACT_TYPE}" == "container" && -z "${IMAGE_REF}" ]]; then
  die "--image is required for --type container" 1
fi

if [[ -z "${ARTIFACT_NAME}" ]]; then
  case "${ARTIFACT_TYPE}" in
    node)      ARTIFACT_NAME="node-app" ;;
    rust)      ARTIFACT_NAME="payment_router" ;;
    container) ARTIFACT_NAME="container-image" ;;
  esac
fi

if [[ -z "${PROJECT_DIR}" ]]; then
  case "${ARTIFACT_TYPE}" in
    rust) PROJECT_DIR="${REPO_ROOT}/payment_router" ;;
    *)    PROJECT_DIR="${REPO_ROOT}" ;;
  esac
fi

mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR="$(cd "${OUTPUT_DIR}" && pwd)"

SBOM_FILE="${OUTPUT_DIR}/${ARTIFACT_NAME}.cdx.json"
MANIFEST_FILE="${OUTPUT_DIR}/${ARTIFACT_NAME}.sbom-manifest.json"
PROVENANCE_FILE="${OUTPUT_DIR}/${ARTIFACT_NAME}.provenance.json"
RAW_SBOM_FILE="${OUTPUT_DIR}/.${ARTIFACT_NAME}.raw.cdx.json"

cleanup() { rm -f "${RAW_SBOM_FILE}"; }
trap cleanup EXIT

# --- Generate raw SBOM per artifact type -------------------------------------

generate_node() {
  require_cmd node
  require_cmd npm
  local lockfile="${PROJECT_DIR}/package-lock.json"
  [[ -f "${lockfile}" ]] || die "package-lock.json not found in ${PROJECT_DIR}" 3

  log "generating Node SBOM via @cyclonedx/cyclonedx-npm"
  # Prefer a locally installed binary, fall back to npx.
  if [[ -x "${PROJECT_DIR}/node_modules/.bin/cyclonedx-npm" ]]; then
    ( cd "${PROJECT_DIR}" && ./node_modules/.bin/cyclonedx-npm \
        --output-format JSON \
        --output-file "${RAW_SBOM_FILE}" \
        --package-lock-only \
        --spec-version 1.5 )
  else
    ( cd "${PROJECT_DIR}" && npx --yes @cyclonedx/cyclonedx-npm \
        --output-format JSON \
        --output-file "${RAW_SBOM_FILE}" \
        --package-lock-only \
        --spec-version 1.5 )
  fi
}

generate_rust() {
  require_cmd cargo
  [[ -f "${PROJECT_DIR}/Cargo.toml" ]] || die "Cargo.toml not found in ${PROJECT_DIR}" 3

  log "generating Rust SBOM via cargo-cyclonedx or cargo-sbom"
  if cargo cyclonedx --version >/dev/null 2>&1; then
    ( cd "${PROJECT_DIR}" && cargo cyclonedx \
        --format json \
        --spec-version 1.5 \
        --override-filename "${RAW_SBOM_FILE}" )
  elif cargo sbom --version >/dev/null 2>&1; then
    ( cd "${PROJECT_DIR}" && cargo sbom --output-format cyclone_dx_json_1_5 > "${RAW_SBOM_FILE}" )
  else
    die "neither cargo-cyclonedx nor cargo-sbom is installed (cargo install cargo-cyclonedx)" 2
  fi
}

generate_container() {
  require_cmd syft
  log "generating container SBOM via syft for ${IMAGE_REF}"
  syft "${IMAGE_REF}" \
    --output "cyclonedx-json=${RAW_SBOM_FILE}" \
    --source-name "${ARTIFACT_NAME}" \
    --source-version "${SOURCE_REVISION}"
}

case "${ARTIFACT_TYPE}" in
  node)      generate_node ;;
  rust)      generate_rust ;;
  container) generate_container ;;
esac

[[ -s "${RAW_SBOM_FILE}" ]] || die "SBOM generation produced no output" 3

# --- Enrich SBOM with source revision and artifact digest --------------------
#
# We embed the git commit SHA and artifact digest as component properties on
# the root component (and as metadata properties) so the SBOM is self-describing
# and traceable back to the exact source revision and artifact.

log "embedding source revision and artifact digest into SBOM metadata"

ENRICH_ARGS=(
  --input "${RAW_SBOM_FILE}"
  --output "${SBOM_FILE}"
  --revision "${SOURCE_REVISION}"
  --digest "${ARTIFACT_DIGEST}"
  --artifact-name "${ARTIFACT_NAME}"
  --artifact-type "${ARTIFACT_TYPE}"
)
if [[ "${ARTIFACT_TYPE}" == "container" ]]; then
  ENRICH_ARGS+=( --image "${IMAGE_REF}" )
fi

if command -v node >/dev/null 2>&1; then
  node "${SCRIPT_DIR}/lib/enrich-sbom.js" "${ENRICH_ARGS[@]}"
else
  die "node is required to enrich the SBOM" 2
fi

[[ -s "${SBOM_FILE}" ]] || die "SBOM enrichment produced no output" 3

# --- Compute SBOM digest and write companion manifest ------------------------

SBOM_DIGEST="$(sha256sum "${SBOM_FILE}" | awk '{print $1}')"
SBOM_SIZE="$(wc -c < "${SBOM_FILE}" | tr -d ' ')"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Generate build provenance attestation -----------------------------------
#
# The provenance is an in-toto statement whose subject is the artifact digest
# and whose predicate records the source revision, workflow identity, and
# toolchain versions. It is written next to the SBOM and referenced from the
# companion manifest.

if [[ "${EMIT_PROVENANCE}" -eq 1 ]]; then
  log "writing provenance attestation ${PROVENANCE_FILE}"
  PROVENANCE_ARGS=(
    --output "${PROVENANCE_FILE}"
    --sbom-file "$(basename "${SBOM_FILE}")"
    --sbom-digest "sha256:${SBOM_DIGEST}"
    --revision "${SOURCE_REVISION}"
    --digest "${ARTIFACT_DIGEST}"
    --artifact-name "${ARTIFACT_NAME}"
    --artifact-type "${ARTIFACT_TYPE}"
    --generated-at "${GENERATED_AT}"
  )
  if [[ "${ARTIFACT_TYPE}" == "container" ]]; then
    PROVENANCE_ARGS+=( --image "${IMAGE_REF}" )
  fi
  node "${SCRIPT_DIR}/lib/write-provenance.js" "${PROVENANCE_ARGS[@]}"
  [[ -s "${PROVENANCE_FILE}" ]] || die "provenance generation produced no output" 3
  PROVENANCE_DIGEST="$(sha256sum "${PROVENANCE_FILE}" | awk '{print $1}')"
fi

log "writing companion manifest ${MANIFEST_FILE}"

MANIFEST_ARGS=(
  --output "${MANIFEST_FILE}"
  --sbom-file "$(basename "${SBOM_FILE}")"
  --sbom-format "CycloneDX"
  --sbom-spec-version "1.5"
  --sbom-digest "sha256:${SBOM_DIGEST}"
  --sbom-size "${SBOM_SIZE}"
  --revision "${SOURCE_REVISION}"
  --digest "${ARTIFACT_DIGEST}"
  --artifact-name "${ARTIFACT_NAME}"
  --artifact-type "${ARTIFACT_TYPE}"
  --generated-at "${GENERATED_AT}"
)
if [[ "${ARTIFACT_TYPE}" == "container" ]]; then
  MANIFEST_ARGS+=( --image "${IMAGE_REF}" )
fi
if [[ "${EMIT_PROVENANCE}" -eq 1 ]]; then
  MANIFEST_ARGS+=(
    --provenance-file "$(basename "${PROVENANCE_FILE}")"
    --provenance-digest "sha256:${PROVENANCE_DIGEST}"
  )
fi

node "${SCRIPT_DIR}/lib/write-sbom-manifest.js" "${MANIFEST_ARGS[@]}"

log "SBOM written to ${SBOM_FILE}"
log "manifest written to ${MANIFEST_FILE}"
printf '%s\n' "${SBOM_FILE}"
printf '%s\n' "${MANIFEST_FILE}"
if [[ "${EMIT_PROVENANCE}" -eq 1 ]]; then
  log "provenance written to ${PROVENANCE_FILE}"
  printf '%s\n' "${PROVENANCE_FILE}"
fi