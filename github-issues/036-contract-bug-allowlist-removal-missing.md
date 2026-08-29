---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] No function to remove address from allowlist"
labels: bug
assignees: ''
---

## Describe the Bug

The contract has `add_to_allowlist` function but no corresponding `remove_from_allowlist`. Once an address is allowlisted, it cannot be removed even if compromised or no longer authorized.

## Steps to Reproduce

1. Admin calls `add_to_allowlist(bad_actor_address)`
2. Later discovers address is malicious
3. Search contract for removal function
4. No such function exists

## Expected Behavior

Admin should be able to call `remove_from_allowlist(address: Address)` to revoke allowlist access.

## Actual Behavior

No removal mechanism exists. Workaround requires contract upgrade and allowlist migration.

## Environment

| Field | Value |
|-------|-------|
| Component | contracts |
| Rust version | rustc 1.77.0 |
| Stellar CLI version | 21.2.0 |
| Network | testnet |

## Additional Context

Function should:
- Verify admin privileges
- Remove address from allowlist storage
- Emit `allowlist_removed` event
- Fail gracefully if address not in list
