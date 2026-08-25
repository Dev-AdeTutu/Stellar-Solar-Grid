---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add quick payment amount presets"
labels: enhancement
assignees: ''
---

## Problem Statement

Users must manually type payment amount each time. For repeat payments, this is tedious. Most users pay same amounts repeatedly (e.g., 5 XLM weekly).

## Proposed Solution

Add payment preset buttons in payment modal:

```
┌─────────────────────────────┐
│  Quick Top-Up               │
│                             │
│  [5 XLM] [10 XLM] [20 XLM] │
│                             │
│  Or custom amount:          │
│  [_________] XLM            │
└─────────────────────────────┘
```

Features:
- Default presets: 5, 10, 20, 50 XLM
- Remember last 3 payment amounts (localStorage)
- Show suggested amount based on usage: "Recommended: 12 XLM for 7 days"
- One-click payment with preset (skip amount input)

Mobile-friendly large tap targets.

## Alternatives Considered

- Auto-payment only: Less user control
- No presets: Current tedious behavior

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

Consider currency preference toggle (XLM / USD equivalent) for users who think in fiat.
