---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Contract doesn't emit event on payment plan change"
labels: bug
assignees: ''
---

## Describe the Bug

The `make_payment` function emits a `payment_received` event but doesn't emit an event when a user changes their payment plan (e.g., from Daily to Weekly). This makes it difficult to track plan migrations in analytics.

## Steps to Reproduce

1. Register a meter with Daily plan
2. Make payment with Daily plan (event emitted ✓)
3. Make another payment with Weekly plan (switches plan but no plan_change event)
4. Query contract events - only see payment_received

## Expected Behavior

Emit a `plan_changed` event containing:
- meter_id
- old_plan
- new_plan
- timestamp

This allows off-chain services to track and analyze plan migrations.

## Actual Behavior

Plan changes occur silently without emitting trackable events.

## Environment

| Field | Value |
|-------|-------|
| Component | contracts |
| Rust version | rustc 1.77.0 |
| Stellar CLI version | 21.2.0 |
| Network | testnet |

## Additional Context

Similar issue might exist for other state changes (deactivation, allowlist additions, etc.).
