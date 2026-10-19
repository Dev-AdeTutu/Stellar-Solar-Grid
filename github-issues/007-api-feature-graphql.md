---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add GraphQL API alongside REST"
labels: enhancement
assignees: ''
---

## Problem Statement

Frontend components often need to fetch related data (meter + balance + usage history + payment history) which currently requires multiple REST API calls. This increases latency and complexity in client code.

## Proposed Solution

Implement a GraphQL API (using Apollo Server or similar) that allows:
- Single query for all related meter data
- Flexible field selection (reduce over-fetching)
- Real-time subscriptions for meter status changes
- Strongly typed schema matching the contract data model

Keep existing REST API for backwards compatibility.

## Alternatives Considered

- BFF (Backend for Frontend) pattern: Still requires multiple internal calls
- Compound REST endpoints: Less flexible than GraphQL

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

GraphQL would particularly benefit the admin dashboard which displays aggregated data from multiple sources.
