---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add promotional discount codes to smart contract"
labels: enhancement
assignees: ''
---

## Problem Statement

Energy providers want to offer promotional discounts (e.g., "New customer 20% off first month") to attract users. Currently, no mechanism exists for on-chain discount validation.

## Proposed Solution

Add discount code system to contract:

```rust
struct DiscountCode {
    code: String,           // "WELCOME20"
    discount_pct: u32,      // 20 = 20% off
    valid_until: u64,       // Expiry timestamp
    max_uses: u32,          // Usage limit
    uses: u32,              // Current usage count
    active: bool
}
```

Functions:
- `admin_create_discount(code, discount_pct, valid_until, max_uses)`
- `admin_revoke_discount(code)`
- `make_payment_with_discount(meter_id, amount, plan, code)`

Validation:
- Check code exists and is active
- Verify not expired
- Check usage limit not exceeded
- Apply discount: `final_cost = amount * (100 - discount_pct) / 100`
- Increment usage counter
- Emit `discount_applied` event

## Alternatives Considered

- Off-chain discounts: No audit trail
- Backend-only validation: Can be bypassed

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Consider per-user discount limits to prevent abuse via multiple accounts.
