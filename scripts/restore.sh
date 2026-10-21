#!/usr/bin/env bash
# #892: Restore a backup archive. Usage: restore.sh <archive.tar.gz>
set -euo pipefail
ARCHIVE="${1:?usage: restore.sh <archive.tar.gz>}"
DATA_DIR="${DATA_DIR:-$(dirname "$0")/../backend/data}"
[ -f "$ARCHIVE.sha256" ] && sha256sum -c "$ARCHIVE.sha256"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
mkdir -p "$DATA_DIR"
cp -a "$TMP"/*/* "$DATA_DIR"/
echo "Restored $ARCHIVE into $DATA_DIR — restart the backend (docker compose restart backend)."
