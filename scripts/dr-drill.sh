#!/usr/bin/env bash
# #892: Quarterly DR drill — backup, restore to a scratch dir, verify integrity, time it against RTO.
set -euo pipefail
START=$(date +%s)
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
BACKUP_DIR="$WORK/backups" "$(dirname "$0")/backup.sh"
ARCHIVE="$(ls -t "$WORK"/backups/*.tar.gz | head -1)"
DATA_DIR="$WORK/restore" "$(dirname "$0")/restore.sh" "$ARCHIVE"
for db in "$WORK"/restore/*.db "$WORK"/restore/*.sqlite; do
  [ -f "$db" ] || continue
  [ "$(sqlite3 "$db" 'PRAGMA integrity_check;')" = "ok" ] || { echo "FAIL: $db corrupt"; exit 1; }
done
ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -lt 14400 ] || { echo "FAIL: RTO exceeded (${ELAPSED}s)"; exit 1; }
echo "DR drill PASSED in ${ELAPSED}s — record result in docs/DISASTER_RECOVERY.md"
