---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Payment history pagination breaks with infinite scroll"
labels: bug
assignees: ''
---

## Describe the Bug

When viewing payment history with 100+ transactions, the pagination buttons stop working after scrolling down. Clicking "Next Page" doesn't load new data, and the page number doesn't update in the URL.

## Steps to Reproduce

1. Create account with 150+ payment transactions
2. Open UserDashboard payment history tab
3. Scroll down past 50 transactions
4. Click "Next Page" button at bottom
5. Observe no new data loads

## Expected Behavior

Pagination should work regardless of scroll position. Clicking "Next Page" should:
- Load next 10 transactions
- Update URL param `?page=2`
- Scroll back to top of payment history section

## Actual Behavior

"Next Page" button appears disabled after scrolling. No API request is made. Console shows no errors.

## Screenshots / Logs

```
// Console warning (may be related):
Intersection Observer entry lost visibility before callback
```

## Environment

| Field | Value |
|-------|-------|
| Component | frontend |
| OS | macOS 14 |
| Browser | Safari 17.4 |
| Network | testnet |

## Additional Context

Issue does not occur in Chrome. May be Safari-specific intersection observer behavior.
