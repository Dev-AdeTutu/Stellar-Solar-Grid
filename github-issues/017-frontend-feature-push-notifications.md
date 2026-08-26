---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add browser push notifications for low balance alerts"
labels: enhancement
assignees: ''
---

## Problem Statement

Users aren't aware their balance is low until they actively check the dashboard, leading to unexpected service interruptions. Proactive notifications would improve user experience.

## Proposed Solution

Implement browser push notifications using the Web Push API:
- Request notification permission on first dashboard visit
- Subscribe to balance alerts when balance < 10% of typical weekly usage
- Show notification: "⚠️ Low Balance: Your meter balance is running low. Top up now to avoid interruption."
- Include "Top Up" action button that opens payment modal
- Store subscription in localStorage and backend

Desktop and mobile browser support via service worker.

## Alternatives Considered

- Email notifications: Requires collecting email addresses
- SMS notifications: Higher cost and complexity
- In-app only: Users may not see if dashboard is closed

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

Requires backend endpoint to manage push subscriptions and trigger notifications based on balance changes.
