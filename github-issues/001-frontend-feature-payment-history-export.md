---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add CSV export for payment history"
labels: enhancement
assignees: ''
---

## Problem Statement

Users need to export their payment history for accounting and record-keeping purposes. Currently, payment history is only viewable in the dashboard with pagination but cannot be exported.

## Proposed Solution

Add a "Download CSV" button to the payment history view in the UserDashboard component that exports all payment records with the following columns:
- Transaction Hash
- Date
- Meter ID
- Amount (XLM)
- Payment Plan
- Status

The export should respect current filter settings (date range, sort order).

## Alternatives Considered

- PDF export: More complex and less useful for data analysis
- JSON export: Less user-friendly for non-technical users
- Third-party analytics tools: Requires additional integrations

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

This feature would be particularly valuable for small business owners who need to track energy expenses for tax purposes.
