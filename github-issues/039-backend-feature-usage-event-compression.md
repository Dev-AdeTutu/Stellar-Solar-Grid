---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Compress historical usage events in SQLite database"
labels: enhancement
assignees: ''
---

## Problem Statement

The usage_events SQLite database grows indefinitely at ~1KB per event. After 6 months with 1000 active meters, database size reaches multiple GB, slowing queries and increasing storage costs.

## Proposed Solution

Implement automated data retention policy:

**Compression strategy:**
- Keep detailed events for last 90 days
- Aggregate older events into daily summaries
- Archive events older than 1 year to cold storage (S3, GCS)
- Run compression job daily at 2 AM UTC

**Aggregated schema:**
```sql
CREATE TABLE usage_summary (
  date TEXT PRIMARY KEY,
  meter_id TEXT,
  total_units INTEGER,
  total_cost INTEGER,
  event_count INTEGER
);
```

Maintains analytics capability while reducing storage 95%.

## Alternatives Considered

- No compression: Unsustainable for production
- Delete old data: Loses valuable analytics history

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Consider using SQLite's `VACUUM` command after deletion to reclaim disk space.
