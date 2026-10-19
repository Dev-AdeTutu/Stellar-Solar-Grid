---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Implement dark mode theme"
labels: enhancement
assignees: ''
---

## Problem Statement

Users working with the dashboard in low-light conditions experience eye strain. Modern applications typically offer dark mode as an accessibility and preference feature.

## Proposed Solution

Implement dark mode with:
- Toggle button in the Navbar component
- Persistent preference stored in localStorage
- CSS variables for theme colors in `globals.css`
- Respect user's system preference (`prefers-color-scheme` media query)
- Smooth transition animations between themes

Color palette should maintain WCAG AA contrast ratios in both modes.

## Alternatives Considered

- Multiple themes (light/dark/auto): More complex initially
- CSS-only solution without toggle: Less user control

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

The recharts library used in UsageChart supports dark themes and will need configuration updates.
