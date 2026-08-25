---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add side-by-side meter comparison view"
labels: enhancement
assignees: ''
---

## Problem Statement

Users with multiple meters cannot easily compare their performance, usage patterns, and costs. They must manually review each meter card individually.

## Proposed Solution

Add "Compare Meters" toggle button in dashboard that switches to comparison table view:

| Metric | Home Solar | Shop Solar | Average |
|--------|-----------|-----------|---------|
| Current Balance | 5.2 XLM | 3.8 XLM | 4.5 XLM |
| Daily Usage | 120 units | 180 units | 150 units |
| Cost/Day | 0.6 XLM | 0.9 XLM | 0.75 XLM |
| Status | Active | Active | - |
| Days Remaining | 8 days | 4 days | - |

Features:
- Sort by any column
- Highlight highest/lowest values
- Export comparison as CSV
- Side-by-side usage charts
- Toggle between card view and table view

## Alternatives Considered

- Separate comparison page: Extra navigation step
- Chart overlay: Too cluttered with 3+ meters

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

Most useful for users with 2-5 meters. Beyond that, consider filtering/grouping features.
