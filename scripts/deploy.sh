#!/usr/bin/env bash
set -Eeuo pipefail

# Usage: scripts/deploy.sh --network local|testnet|mainnet [--contract-id ID]
# Required environment: ADMIN_SECRET_KEY for deployment. TOKEN_ADDRESS is used
# for initialization when the contract constructor is unavailable.
NETWORK="testnet"
CONTRACT_ID=""
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="${ROOT_DIR}/contracts/target/wasm32-unknown-unknown/release/solar_grid.wasm"
STATE_DIR="${ROOT_DIR}/.deployments"

usage() { sed -n '1,8p' "$0"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="${2:?missing network}"; shift 2 ;;
    --contract-id) CONTRACT_ID="${2:?missing contract id}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$NETWORK" in local|testnet|mainnet) ;; *) echo "network must be local, testnet, or mainnet" >&2; exit 2 ;; esac
: "${ADMIN_SECRET_KEY:?ADMIN_SECRET_KEY is required}"
: "${TOKEN_ADDRESS:?TOKEN_ADDRESS is required for initialization}"

if [[ "$NETWORK" == mainnet && "${ALLOW_MAINNET_DEPLOY:-0}" != 1 ]]; then
  echo "Refusing mainnet deployment. Set ALLOW_MAINNET_DEPLOY=1 after reviewing the artifact." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
cd "$ROOT_DIR/contracts"
cargo build --release --target wasm32-unknown-unknown
sha256sum "$WASM" | tee "$STATE_DIR/${NETWORK}-wasm.sha256"

if [[ -z "$CONTRACT_ID" ]]; then
  CONTRACT_ID="$(stellar contract deploy --wasm "$WASM" --source "$ADMIN_SECRET_KEY" --network "$NETWORK")"
  printf '%s\n' "$CONTRACT_ID" > "$STATE_DIR/${NETWORK}-contract.id"
fi

stellar contract invoke --id "$CONTRACT_ID" --source "$ADMIN_SECRET_KEY" --network "$NETWORK" \
  -- initialize --admin "$(stellar keys address "$ADMIN_SECRET_KEY")" --token-address "$TOKEN_ADDRESS"

if ! stellar contract invoke --id "$CONTRACT_ID" --source "$ADMIN_SECRET_KEY" --network "$NETWORK" \
  -- get_contract_version >/dev/null; then
  echo "Post-deployment verification failed; attempting rollback by removing the recorded deployment." >&2
  rm -f "$STATE_DIR/${NETWORK}-contract.id"
  exit 1
fi

echo "Deployment verified: ${CONTRACT_ID} (${NETWORK})"
