---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Improve keyboard navigation and screen reader support"
labels: enhancement, a11y
assignees: ''
---

## Problem Statement

The dashboard is not fully accessible to users with disabilities. Keyboard-only users cannot navigate all interactive elements, and screen readers announce components incorrectly.

## Proposed Solution

Implement WCAG 2.1 AA compliance:

**Keyboard navigation:**
- All interactive elements reachable via Tab
- Skip to main content link
- Escape key closes modals
- Arrow keys navigate between meter cards
- Enter/Space activates buttons

**Screen reader support:**
- Proper ARIA labels on all buttons and inputs
- ARIA live regions for dynamic content (balance updates)
- Descriptive alt text on all icons and charts
- Semantic HTML (nav, main, section, article)

**Visual indicators:**
- Clear focus outlines (3px, high contrast)
- Focus trap in modals

## Alternatives Considered

- Basic compliance only: Doesn't serve all users
- Manual testing only: Misses many issues

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Run `axe-core` automated tests and manual screen reader testing (NVDA, JAWS, VoiceOver).
