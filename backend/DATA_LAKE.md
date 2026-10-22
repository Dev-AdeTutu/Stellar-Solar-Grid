# Meter Telemetry Data Lake

Long-term, low-cost storage of all meter telemetry for analytics
(`src/lake/dataLake.ts`).

## Layout

Hive-style date partitions of newline-delimited JSON:

```
$LAKE_ROOT/
  _watermark.json                         # last exported usage_events.id
  meter_telemetry/
    dt=2026-01-01/part-1-500.ndjson
    dt=2026-01-02/part-501-900.ndjson
```

The layout is directly readable by Athena, Trino, DuckDB and Spark
(`read_json('meter_telemetry/*/*.ndjson', hive_partitioning=true)`).
For S3 or equivalent object storage, mount the bucket (s3fs, goofys,
rclone) at `LAKE_ROOT` or sync it with `aws s3 sync`.

## ETL pipeline

`startDataLakeWorker` runs on boot and every `LAKE_ETL_INTERVAL_MS`:

1. Read rows from the operational SQLite `usage_events` table with
   `id > watermark` (batches of 10k).
2. Group by `received_at` date and write one immutable part file per partition.
3. Atomically advance the watermark — ETL is incremental and idempotent per batch.
4. Apply retention.

## Query interface

| Endpoint | Description |
|---|---|
| `GET /api/lake/partitions` | Available dates |
| `GET /api/lake/telemetry?from=&to=&meterId=` | Raw rows (partition-pruned, max 10k) |
| `GET /api/lake/summary?from=&to=&meterId=` | Per-meter events, units and cost |

Programmatic: `dataLake.query(q)` / `dataLake.summarize(q)`.

## Retention

Partitions older than `LAKE_RETENTION_DAYS` (default 730) are deleted.
On S3, an equivalent bucket lifecycle rule (e.g. transition to Glacier after
90 days, expire after 730) is recommended.

## Configuration

| Variable | Default |
|---|---|
| `LAKE_ROOT` | `./data/lake` |
| `LAKE_RETENTION_DAYS` | `730` |
| `LAKE_ETL_INTERVAL_MS` | `3600000` |

## Tests

`npm run test:lake` — incremental ETL, partitioning, pruning, aggregation, retention.
