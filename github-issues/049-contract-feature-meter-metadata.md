---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add metadata field to meter registration"
labels: enhancement
assignees: ''
---

## Problem Statement

Meters have no associated metadata (location, capacity, installation date, hardware model). This makes fleet management and analytics difficult for energy providers.

## Proposed Solution

Extend `register_meter` to accept optional metadata map:

```rust
struct Meter {
    // ... existing fields
    metadata: Map<String, String>
}
```

Example metadata:
```rust
{
  "location": "Nairobi, Kenya",
  "capacity_kw": "5.0",
  "install_date": "2025-08-01",
  "hardware_model": "SolarMax-500",
  "latitude": "-1.2921",
  "longitude": "36.8219"
}
```

Functions:
- `register_meter(meter_id, owner, metadata)`
- `update_meter_metadata(meter_id, key, value)` - owner/admin only
- `get_meter_metadata(meter_id)` - public

Max metadata: 10 key-value pairs, 100 chars per value.

## Alternatives Considered

- Off-chain metadata: No audit trail, trust issues
- Separate metadata contract: More complex queries

## Affected Component(s)

- [x] Frontend (React / TypeScript)
- [ ] Backend / IoT bridge (Node.js)
- [x] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Enables features like "meters near me" map view and capacity-based analytics.
