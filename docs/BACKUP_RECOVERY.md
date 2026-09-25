# Backup and Recovery Guide

This document describes backup, restore, and disaster recovery procedures for the
platform. It covers the database, on-chain contract state, and IoT device
configuration, and defines the recovery objectives the team commits to.

## Recovery Objectives

| Objective | Target | Notes |
| --- | --- | --- |
| Recovery Time Objective (RTO) | 4 hours | Time to restore full service after a declared incident. |
| Recovery Point Objective (RPO) | 15 minutes | Maximum acceptable data loss window. |

- **RTO** is measured from incident declaration to verified service restoration.
- **RPO** is achieved through continuous WAL archiving plus 15-minute incremental
  snapshots. If the archive pipeline is degraded, the effective RPO widens to the
  last successful snapshot.

## Database Backups

### Automated backups

- **Full backup:** daily at 02:00 UTC, retained for 30 days.
- **Incremental backup:** every 15 minutes, retained for 7 days.
- **WAL archiving:** continuous, shipped to object storage for point-in-time recovery.

### Manual backup

```bash
pg_dump --format=custom --file=backup-$(date +%Y%m%d%H%M).dump "$DATABASE_URL"
```

### Restore

```bash
# Restore the most recent full backup into a fresh database
pg_restore --clean --if-exists --dbname="$DATABASE_URL" backup-YYYYMMDDHHMM.dump

# Point-in-time recovery to a specific timestamp
pg_restore --dbname="$DATABASE_URL" --create --clean \
  --target-time="2024-01-01 12:00:00 UTC" backup-YYYYMMDDHHMM.dump
```

### Verification

1. Restore the latest backup into a staging database.
2. Run the application smoke test suite against the restored database.
3. Confirm row counts for critical tables match the source within the RPO window.

## Contract State Export / Import

The smart contract stores meter metadata and lifecycle state on-chain. Because
on-chain state cannot be "restored" from a database backup, export it regularly
and keep the exports alongside database backups.

### Export

```bash
# Export current contract state to a JSON snapshot
contract-cli export-state --network mainnet --output contract-state-$(date +%Y%m%d).json
```

### Import / recovery

```bash
# Replay an exported snapshot into a recovered or replacement contract
contract-cli import-state --network mainnet --input contract-state-YYYYMMDD.json
```

### Notes

- Exports are immutable snapshots; store them in versioned object storage.
- After any contract redeploy, re-import the latest snapshot and verify meter
  counts and metadata hashes against the database index.
- Keep at least the last 30 daily exports.

## IoT Configuration Backups

Device configuration (network credentials, firmware version, calibration data)
should be backed up so devices can be reprovisioned after failure.

### Export device configuration

```bash
# Export configuration for a single device
iot-cli export-config --device-id "$DEVICE_ID" --output device-$DEVICE_ID.json

# Export configuration for all devices in a fleet
iot-cli export-config --fleet "$FLEET_ID" --output fleet-$FLEET_ID-$(date +%Y%m%d).json
```

### Restore device configuration

```bash
iot-cli import-config --device-id "$DEVICE_ID" --input device-$DEVICE_ID.json
```

### Notes

- Fleet exports run daily and are retained for 30 days.
- Configuration exports contain credentials; store them encrypted at rest and
  restrict access to the operations team.
- After restoring a device, confirm it reconnects and reports telemetry before
  returning it to service.

## Disaster Recovery Runbook

1. **Declare the incident.** Assign an incident commander and open an incident channel.
2. **Assess scope.** Determine whether the database, contract state, IoT fleet, or
   a combination is affected.
3. **Freeze writes.** Put the application into read-only mode to protect the RPO.
4. **Restore the database.** Follow the restore procedure above, targeting the
   latest backup within the RPO window.
5. **Recover contract state.** Re-import the latest contract state export and
   verify meter counts and metadata hashes.
6. **Restore IoT configuration.** Re-import fleet configuration and confirm devices
   reconnect and report telemetry.
7. **Verify.** Run the smoke test suite and reconcile critical row counts.
8. **Resume writes.** Lift read-only mode once verification passes.
9. **Post-incident review.** Record the actual RTO/RPO achieved and file follow-ups.

## Tested Recovery Procedures

Recovery procedures are exercised on a quarterly schedule:

- **Quarterly restore drill:** restore the latest database backup into staging and
  run the smoke test suite.
- **Contract state drill:** import the latest export into a test network and verify
  meter counts and metadata hashes.
- **IoT reprovision drill:** restore a sample fleet configuration and confirm
  devices reconnect.

Record the date, participants, actual RTO/RPO, and any issues found for each drill.
