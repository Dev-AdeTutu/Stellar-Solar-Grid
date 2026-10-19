---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Balance display shows incorrect decimal places"
labels: bug
assignees: ''
---

## Describe the Bug

Balance amounts are sometimes displayed with excessive decimal places (e.g., "0.50000003 XLM") or inconsistent rounding (e.g., "1.2345" vs "1.23"). This looks unprofessional and confuses users.

## Steps to Reproduce

1. Make payment of 1.5 XLM
2. Use some energy (0.123456 XLM worth)
3. View balance in dashboard
4. Observe balance shows "1.376544 XLM" (6 decimals)

## Expected Behavior

All balance displays should consistently show 2 decimal places for XLM amounts:
- "1.38 XLM" (rounded up)
- "0.50 XLM"
- "10.00 XLM"

Show full precision only in transaction details when explicitly requested.

## Actual Behavior

Decimal precision varies by component and calculation method. Some places show stroops converted incorrectly.

## Screenshots / Logs

MeterCard shows: `0.5000000 XLM`
Payment history shows: `0.5 XLM`
Inconsistent user experience.

## Environment

| Field | Value |
|-------|-------|
| Component | frontend |
| OS | Windows 11 |
| Browser | Chrome 124 |
| Network | testnet |

## Additional Context

Use `toFixed(2)` consistently or create utility function `formatXLM(stroops: number): string` for consistent formatting.
