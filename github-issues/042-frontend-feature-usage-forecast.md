---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add usage forecasting and remaining days estimate"
labels: enhancement
assignees: ''
---

## Problem Statement

Users don't know how long their current balance will last based on their usage patterns. They want to see "Estimated X days remaining" so they can plan payments proactively.

## Proposed Solution

Add usage forecasting widget to UserDashboard:
- Calculate average daily usage from past 7 days
- Project current balance / avg_daily_usage = days remaining
- Display: "~5 days remaining at current usage"
- Show confidence indicator (±1 day if usage varies)
- Warning icon if < 2 days remaining

Handle edge cases:
- New meter (< 7 days data): "Not enough data yet"
- Zero usage: "Unlimited at current usage"
- Variable usage: Show range "3-7 days remaining"

## Alternatives Considered

- ML-based forecasting: Too complex for initial version
- No forecasting: Users manually calculate

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

SolarForecast component already exists — can reuse similar UI pattern for usage forecast.
