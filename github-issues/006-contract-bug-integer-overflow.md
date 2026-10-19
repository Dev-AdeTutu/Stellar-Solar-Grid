---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Potential integer overflow in balance calculations"
labels: bug
assignees: ''
---

## Describe the Bug

The `make_payment` function uses `checked_add` for balance updates but `units_used` subtraction in `check_access` and `update_usage` does not use checked arithmetic. This could cause integer overflow/underflow in edge cases with very large usage values.

## Steps to Reproduce

1. Deploy contract to testnet
2. Register a meter and make large payment (e.g., 9_000_000_000_000 stroops)
3. Call `update_usage` with extremely large units value (close to u64::MAX)
4. Observe potential panic or wraparound behavior

## Expected Behavior

All arithmetic operations on balances and units should use checked operations (`checked_sub`, `checked_mul`, etc.) and return proper errors on overflow/underflow.

## Actual Behavior

Unchecked arithmetic may cause panics or silent wraparound leading to incorrect balance calculations.

## Screenshots / Logs

```rust
// In check_access:
let units_consumed = meter.units_used.saturating_sub(last_checked);
let cost = units_consumed * UNIT_PRICE; // Unchecked multiplication
```

## Environment

| Field | Value |
|-------|-------|
| Component | contracts |
| Rust version | rustc 1.77.0 |
| Stellar CLI version | 21.2.0 |
| Network | testnet |

## Additional Context

Consider using `saturating_*` or `checked_*` methods consistently throughout the contract for all balance and usage arithmetic.
