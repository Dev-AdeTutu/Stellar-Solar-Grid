#!/usr/bin/env bash
# #892: Hourly backup of backend SQLite data + config (RPO < 1h). Run via cron:
#   0 * * * * /app/scripts/backup.sh >> /var/log/solargrid-backup.log 2>&1
set -euo pipefail
DATA_DIR="${DATA_DIR:-$(dirname "$0")/../backend/data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/solargrid}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$TS"
mkdir -p "$DEST"
for db in "$DATA_DIR"/*.db "$DATA_DIR"/*.sqlite; do
  [ -f "$db" ] || continue
  sqlite3 "$db" ".backup '$DEST/$(basename "$db")'"   # consistent online snapshot
done
cp -a "$DATA_DIR"/*.json "$DEST"/ 2>/dev/null || true
tar -czf "$DEST.tar.gz" -C "$BACKUP_DIR" "$TS" && rm -rf "$DEST"
sha256sum "$DEST.tar.gz" > "$DEST.tar.gz.sha256"
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  aws s3 cp "$DEST.tar.gz" "s3://$BACKUP_S3_BUCKET/" && aws s3 cp "$DEST.tar.gz.sha256" "s3://$BACKUP_S3_BUCKET/"
fi
find "$BACKUP_DIR" -name '*.tar.gz*' -mtime +"$RETENTION_DAYS" -delete
echo "[$TS] backup ok: $DEST.tar.gz"
