---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Time-based access checks fail near daylight saving time transitions"
labels: bug
assignees: ''
---

## Describe the Bug

The contract uses ledger timestamps for time-based payment plan validation (Daily, Weekly). During daylight saving time transitions, users may lose or gain an hour of access due to timestamp comparison issues.

## Steps to Reproduce

1. Make Daily payment (24 hour access) at 2025-03-08 01:00 (day before DST)
2. Wait until 2025-03-09 03:00 (after DST transition, clock "springs forward")
3. Call `check_access` - meter deactivated 1 hour early

## Expected Behavior

Access duration should be calculated in elapsed seconds (86400 for daily), independent of timezone or DST changes.

## Actual Behavior

Timestamp arithmetic may incorrectly calculate elapsed time during DST transitions.

## Environment

| Field | Value |
|-------|-------|
| Component | contracts |
| Rust version | rustc 1.77.0 |
| Stellar CLI version | 21.2.0 |
| Network | testnet |

## Additional Context

Stellar ledger timestamps are Unix epoch (UTC, no DST). This may be a non-issue if all calculations are in UTC. Verify with timezone-edge-case tests.
