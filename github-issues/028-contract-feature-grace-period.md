---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add configurable grace period before meter deactivation"
labels: enhancement
assignees: ''
---

## Problem Statement

When a user's balance reaches zero, their meter is immediately deactivated. This creates poor UX during edge cases (delayed payment confirmation, network issues). Users need a small buffer period.

## Proposed Solution

Add configurable grace period (default: 2 hours) before deactivation:

```rust
struct Meter {
    // ... existing fields
    grace_expires_at: Option<u64>, // Timestamp when grace ends
}
```

Behavior:
- When balance reaches 0, set `grace_expires_at = now + GRACE_PERIOD`
- During grace period, `check_access` returns `true` with warning flag
- After grace expires, deactivate meter
- New payment clears grace period

Admin can configure `GRACE_PERIOD` via contract initialization (in seconds).

## Alternatives Considered

- No grace period: Current behavior, harsh UX
- Fixed grace period: Less flexible for different providers

## Affected Component(s)

- [x] Frontend (React / TypeScript) - Show grace warning
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Grace period should not compound — multiple balance=0 events shouldn't extend grace indefinitely.
