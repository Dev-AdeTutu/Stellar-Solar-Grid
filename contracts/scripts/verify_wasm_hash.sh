#!/usr/bin/env bash
# verify_wasm_hash.sh — Build-time WASM integrity check for SolarGrid contracts.
#
# Usage:
#   ./contracts/scripts/verify_wasm_hash.sh
#
# Optional environment variables:
#   WASM_FILE    Path to the compiled .wasm artifact.
#                Defaults to: contracts/target/wasm32-unknown-unknown/release/solar_grid.wasm
#   CONTRACT_ID  Deployed Stellar contract ID.  When set, the script fetches the
#                on-chain WASM hash via `stellar contract info` and compares it
#                against the local sha256sum.  Exit 1 on mismatch.
#                When not set, just prints the local hash and exits 0.
#   NETWORK      Stellar network to query (default: testnet).
#
# Exit codes:
#   0  Hash matches (or CONTRACT_ID not supplied — local hash printed only).
#   1  Hash mismatch or a prerequisite check failed.

set -euo pipefail

# ── defaults ──────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WASM_FILE="${WASM_FILE:-${REPO_ROOT}/contracts/target/wasm32-unknown-unknown/release/solar_grid.wasm}"
NETWORK="${NETWORK:-testnet}"

# ── sanity checks ─────────────────────────────────────────────────────────────
if [[ ! -f "${WASM_FILE}" ]]; then
  echo "ERROR: WASM file not found: ${WASM_FILE}" >&2
  echo "       Build the contract first: cargo build --target wasm32-unknown-unknown --release" >&2
  exit 1
fi

if ! command -v sha256sum &>/dev/null; then
  echo "ERROR: sha256sum is not available. Install coreutils." >&2
  exit 1
fi

# ── compute local hash ────────────────────────────────────────────────────────
LOCAL_HASH=$(sha256sum "${WASM_FILE}" | awk '{print $1}')
echo "Local WASM : ${WASM_FILE}"
echo "SHA-256    : ${LOCAL_HASH}"

# ── early exit when no CONTRACT_ID supplied ───────────────────────────────────
if [[ -z "${CONTRACT_ID:-}" ]]; then
  echo "CONTRACT_ID not set — skipping on-chain comparison."
  echo "Set CONTRACT_ID to enable hash verification against a deployed contract."
  exit 0
fi

# ── fetch on-chain hash ───────────────────────────────────────────────────────
if ! command -v stellar &>/dev/null; then
  echo "ERROR: stellar CLI not found. Install it to enable on-chain verification." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is not available. Install jq to parse stellar contract info output." >&2
  exit 1
fi

echo ""
echo "Fetching on-chain contract info for ${CONTRACT_ID} on ${NETWORK}…"

STELLAR_OUTPUT=$(stellar contract info --id "${CONTRACT_ID}" --network "${NETWORK}" 2>&1) || {
  echo "ERROR: stellar contract info failed:" >&2
  echo "${STELLAR_OUTPUT}" >&2
  exit 1
}

# Extract the wasm hash field.  `stellar contract info` returns JSON with a
# top-level "hash" key whose value is a lowercase hex SHA-256 string.
ONCHAIN_HASH=$(echo "${STELLAR_OUTPUT}" | jq -r '.hash // empty')

if [[ -z "${ONCHAIN_HASH}" ]]; then
  echo "ERROR: Could not extract 'hash' field from stellar contract info output." >&2
  echo "       Raw output:" >&2
  echo "${STELLAR_OUTPUT}" >&2
  exit 1
fi

echo "On-chain hash: ${ONCHAIN_HASH}"

# ── compare (case-insensitive) ────────────────────────────────────────────────
LOCAL_LOWER=$(echo "${LOCAL_HASH}" | tr '[:upper:]' '[:lower:]')
ONCHAIN_LOWER=$(echo "${ONCHAIN_HASH}" | tr '[:upper:]' '[:lower:]')

if [[ "${LOCAL_LOWER}" == "${ONCHAIN_LOWER}" ]]; then
  echo ""
  echo "✅  WASM hash MATCHES — local build is consistent with the deployed contract."
  exit 0
else
  echo ""
  echo "❌  WASM hash MISMATCH!" >&2
  echo "    Local  : ${LOCAL_LOWER}" >&2
  echo "    On-chain: ${ONCHAIN_LOWER}" >&2
  echo ""
  echo "The locally built WASM does not match the contract deployed at ${CONTRACT_ID}." >&2
  echo "Possible causes:" >&2
  echo "  • Source code changed after the last deploy." >&2
  echo "  • Different Rust toolchain or cargo flags used." >&2
  echo "  • Wrong CONTRACT_ID specified." >&2
  exit 1
fi
