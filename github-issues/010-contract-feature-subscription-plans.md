---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add monthly subscription payment plans"
labels: enhancement
assignees: ''
---

## Problem Statement

Current payment plans (Daily, Weekly, Usage-based) require frequent payments. Users want a monthly subscription option for predictable billing and reduced transaction frequency.

## Proposed Solution

Extend the `PaymentPlan` enum in the smart contract to include:
```rust
enum PaymentPlan {
    Daily,
    Weekly,
    Monthly,  // NEW
    Usage,
}
```

Monthly plan behavior:
- Payment gives 30 days of unlimited access
- Balance represents remaining days (not units)
- Access is granted as long as days > 0
- Usage tracking still occurs for analytics

Update `make_payment` and `check_access` logic to handle the new plan type.

## Alternatives Considered

- 30-day plan (fixed period): Less user-friendly naming
- Quarterly/annual plans: Can add later if needed

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Requires contract migration for existing meters. See ARCHITECTURE_DIAGRAM.md section on contract upgrades.
