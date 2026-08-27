---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Generate QR codes for mobile wallet payments"
labels: enhancement
assignees: ''
---

## Problem Statement

Users without desktop computers or browser extensions need to pay from mobile wallets. Currently, they must manually copy addresses and amounts, which is error-prone.

## Proposed Solution

Add QR code generation for payments using the SEP-0007 URI scheme:
```
web+stellar:pay?destination=GCONTRACT...&
amount=5&memo=METER123&msg=Energy%20Payment
```

Features:
- Display QR code in payment modal
- Include meter ID in memo field
- Pre-fill payment amount
- Support scanning from Lobstr, Solar wallet, etc.
- Fallback to manual payment for desktop wallets

Use existing `qrcode.react` library (already in package.json).

## Alternatives Considered

- Deep links only: Doesn't work cross-platform
- Manual address entry: Current behavior, poor UX

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

QR codes should include error correction level M (15% damage tolerance) for reliability in poor lighting conditions.
