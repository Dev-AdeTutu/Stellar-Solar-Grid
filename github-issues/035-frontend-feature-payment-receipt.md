---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Generate downloadable payment receipts"
labels: enhancement
assignees: ''
---

## Problem Statement

Users need proof of payment for personal records and dispute resolution. Currently, they only have transaction hashes which are not user-friendly receipts.

## Proposed Solution

Add "Download Receipt" button to completed payments in payment history:

**Receipt content (PDF or HTML):**
- Receipt number (transaction hash)
- Date and time
- Meter ID and nickname
- Amount paid (XLM and USD equivalent)
- Payment plan selected
- Energy provider details
- QR code linking to blockchain explorer
- "This is an automated receipt" footer

Generate using:
- `jspdf` library for PDF generation
- Stellar Horizon API for USD exchange rate
- Company logo and branding

## Alternatives Considered

- Email receipts: Requires collecting email addresses
- Blockchain-only proof: Too technical for average users

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [ ] Documentation
- [ ] Other

## Additional Context

Receipt design should follow standard accounting formats for easy recognition by bookkeepers.
