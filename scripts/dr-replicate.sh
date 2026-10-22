#!/usr/bin/env bash
# #1060: Replicate the primary SQLite databases to the DR site (run every 5 min to keep RPO < 15 min).
# Env: DATA_DIR (default backend/data), DR_TARGET (rsync target, e.g. dr-host:/app/backend/data)
set -euo pipefail
DATA_DIR="${DATA_DIR:-backend/data}"
: "${DR_TARGET:?DR_TARGET must be set}"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
for db in "$DATA_DIR"/*.db "$DATA_DIR"/*.sqlite; do
  [ -f "$db" ] || continue
  sqlite3 "$db" ".backup '$STAGE/$(basename "$db")'"
done
rsync -az --delete "$STAGE"/ "$DR_TARGET"/
date -u +%s > "$STAGE/.last_replicated"
rsync -az "$STAGE/.last_replicated" "$DR_TARGET"/
echo "replicated to $DR_TARGET at $(date -u +%FT%TZ)"
