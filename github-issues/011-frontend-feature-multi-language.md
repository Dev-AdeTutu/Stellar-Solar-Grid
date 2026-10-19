---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add French and Swahili translations"
labels: enhancement
assignees: ''
---

## Problem Statement

The platform targets African markets where French (West/Central Africa) and Swahili (East Africa) are widely spoken. Currently only English is supported, limiting accessibility for non-English speakers.

## Proposed Solution

Leverage the existing `next-intl` setup to add:
- French (fr) translations in `frontend/src/locales/fr.json`
- Swahili (sw) translations in `frontend/src/locales/sw.json`
- Language selector dropdown in Navbar
- Persistent language preference in localStorage

Translate all user-facing strings including:
- Dashboard labels and buttons
- Error messages and validation feedback
- Payment plan descriptions
- Help text and tooltips

## Alternatives Considered

- Professional translation service: More expensive but higher quality
- Community-driven translations: Slower but more authentic

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

The i18n infrastructure is already in place. This issue focuses on content translation and UI for language selection.
