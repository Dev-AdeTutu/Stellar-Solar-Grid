---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] UsageChart displays incorrect timestamps for users in non-UTC timezones"
labels: bug
assignees: ''
---

## Describe the Bug

The UsageChart component displays usage data with timestamps that don't match the user's local timezone. Data points appear shifted by several hours, making it difficult to correlate usage with actual time of day.

## Steps to Reproduce

1. Set system timezone to EAT (UTC+3) - Nairobi, Kenya
2. Open UserDashboard
3. View usage chart showing yesterday's data
4. Observe x-axis labels show times in UTC instead of local time

## Expected Behavior

Chart should display timestamps in the user's local timezone with clear indication (e.g., "2:00 PM EAT" or "14:00 +03:00").

## Actual Behavior

All timestamps displayed in UTC with no timezone indicator, confusing users about when actual usage occurred.

## Screenshots / Logs

```
X-axis shows: 06:00, 12:00, 18:00 (UTC)
User expects: 09:00, 15:00, 21:00 (EAT)
```

## Environment

| Field | Value |
|-------|-------|
| Component | frontend |
| OS | Ubuntu 22.04 |
| Browser | Firefox 125 |
| Timezone | Africa/Nairobi (EAT, UTC+3) |
| Network | testnet |

## Additional Context

Recharts supports timezone formatting via `tickFormatter`. The backend already returns ISO 8601 timestamps with timezone info.
