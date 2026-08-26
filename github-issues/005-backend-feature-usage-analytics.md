---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add usage analytics and trends endpoint"
labels: enhancement
assignees: ''
---

## Problem Statement

Energy providers need insights into usage patterns across their meter fleet to:
- Forecast energy demand
- Identify high-usage customers
- Detect anomalous consumption patterns
- Plan capacity and maintenance

Currently, data must be manually aggregated from individual meter queries.

## Proposed Solution

Add `GET /api/analytics/usage` endpoint that returns:
- Daily/weekly/monthly aggregated usage statistics
- Top 10 highest consuming meters
- Average usage per active meter
- Usage trend data (increasing/decreasing)
- Peak usage times
- Query parameters: `start_date`, `end_date`, `granularity` (daily/weekly/monthly), `meter_id` (optional filter)

Cache results for 5 minutes to reduce contract RPC load.

## Alternatives Considered

- Real-time analytics: Too resource-intensive for current scale
- Third-party analytics platform: Adds external dependency

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Could leverage the existing usage_events SQLite database for efficient querying without hitting the blockchain for every analytics request.
