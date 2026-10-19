# Disaster Recovery Plan (#892)

## Objectives
| Metric | Target |
|---|---|
| RPO (max data loss) | < 1 hour — hourly backups |
| RTO (max downtime) | < 4 hours |

## Backup strategy
- `scripts/backup.sh` runs hourly via cron: `0 * * * * /app/scripts/backup.sh`
- SQLite files are snapshotted with `sqlite3 .backup` (consistent while online), archived, checksummed.
- Off-site copy to S3 when `BACKUP_S3_BUCKET` is set; 30-day retention (`RETENTION_DAYS`).
- On-chain state (Soroban contract) is replicated by the Stellar network and needs no backup; keep `CONTRACT_ID` and secrets in the secret manager.

## Recovery procedures
1. **Declare incident** — on-call engineer notifies the team channel, starts incident log.
2. **Assess** — identify failed component (backend host, DB corruption, MQTT broker, RPC provider).
3. **Provision** — `docker compose up -d` on a standby host (or restart on the same host).
4. **Restore data** — `scripts/restore.sh /var/backups/solargrid/<latest>.tar.gz` (or fetch from S3 first).
5. **Verify** — `GET /health`, `GET /api/stats`, confirm IoT bridge reconnects to MQTT.
6. **Cut over** — update DNS / load balancer to the recovered host.
7. **Post-mortem** within 5 business days.

## Failover mechanisms
- **Stellar RPC**: set a secondary `STELLAR_RPC_URL`; switch the env var and restart if the primary is down.
- **MQTT broker**: devices reconnect automatically; run a standby Mosquitto with the same `mosquitto.conf`.
- **Backend**: stateless apart from `backend/data`; any host with a restored data dir can serve.

## Testing schedule
- Quarterly drill (Jan/Apr/Jul/Oct, 1st day) via `.github/workflows/dr-drill.yml` running `scripts/dr-drill.sh`,
  which backs up, restores to a scratch dir, runs `PRAGMA integrity_check`, and fails if RTO is exceeded.
- Record each drill below.

| Date | Operator | Duration | Result | Notes |
|---|---|---|---|---|
| | | | | |

## Training
- New on-call engineers perform one supervised restore using this document.
- Runbook reviewed after every drill and incident.
