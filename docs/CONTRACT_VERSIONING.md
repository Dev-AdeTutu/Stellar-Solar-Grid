# Contract Schema Versioning

## Overview

The Stellar SolarGrid contract maintains a `version` field on each `Meter` struct to track schema evolution over time. This document explains how contract schema versions are exposed via the REST API and how API consumers can detect version mismatches.

## Current Schema Version

**v2** (current as of 2025)

### Version History

| Version | Changes | Migration Function |
|---------|---------|-------------------|
| v0 | Initial schema with `balance` field | `migrate_meter()` |
| v1 | Removed `balance`, introduced time-based expiry | `migrate_meter()` |
| v2 | Added daily spending limits (`daily_limit`, `day_spent`, `day_start`) | `migrate_meter_to_v2()` |

## Exposing Contract Version via API

### GET /api/health

The health endpoint now includes contract schema version information:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 3600,
  "contract": {
    "id": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    "schemaVersion": 2
  },
  "dependencies": {
    "stellarRpc": "ok",
    "mqtt": "ok"
  }
}
```

**Fields:**

- `contract.id` — Deployed Stellar contract address (from `CONTRACT_ID` env var)
- `contract.schemaVersion` — Expected meter schema version from the contract
  - Returns `null` if the contract query fails
  - Queried via the `get_contract_version()` contract function

## API Version vs Contract Schema Version

### REST API Version

The REST API version follows semantic versioning and is exposed via:
- `GET /api/health` → `version` field
- Derived from `backend/package.json`

**Current:** v0.1.0

### Contract Schema Version

The contract schema version is a monotonically increasing integer that tracks the `Meter` struct layout:
- Exposed via `GET /api/health` → `contract.schemaVersion`
- Defined as `CURRENT_METER_VERSION` constant in the contract
- Queried via `get_contract_version()` contract function

**Current:** v2

### Relationship

| REST API Version | Minimum Contract Schema Version | Notes |
|------------------|--------------------------------|-------|
| 0.1.0 | v2 | Daily limit support introduced |
| 0.0.x | v1 | Time-based expiry |

**Compatibility Rules:**

1. The backend API expects meters at the current schema version (v2)
2. If `contract.schemaVersion` returns a lower version, meters must be migrated via:
   - v0 → v2: Call `migrate_meter(meter_id)` (admin only)
   - v1 → v2: Call `migrate_meter_to_v2(meter_id)` (admin only)
3. Future contract schema changes will increment `CURRENT_METER_VERSION` and may require backend API updates

## Detecting Version Mismatches

### Frontend / API Consumer

```javascript
const health = await fetch('/api/health').then(r => r.json());

if (health.contract.schemaVersion < 2) {
  console.warn(`Contract schema is v${health.contract.schemaVersion}, but API expects v2`);
  // Show migration prompt to admin
}
```

### Backend Implementation

The backend queries `get_contract_version()` on every health check to ensure the exposed version is always current. If the contract has been redeployed with a different schema version, the health endpoint will reflect this immediately.

## Migration Workflow

When a new meter schema version is deployed:

1. **Deploy Updated Contract** — Increment `CURRENT_METER_VERSION` in the contract code and redeploy
2. **Run Migrations** — For each existing meter:
   ```bash
   stellar contract invoke \
     --id $CONTRACT_ID \
     --source admin \
     --network testnet \
     -- migrate_meter_to_v2 \
     --meter_id METER_ID
   ```
3. **Update API** — If the schema change requires backend code changes, update the backend and bump `package.json` version
4. **Verify** — Check `GET /api/health` to confirm `contract.schemaVersion` matches the deployed version

## Contract Function Reference

### `get_contract_version() -> u32`

**Access:** Public (read-only)  
**Returns:** Current expected meter schema version

**Example:**
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --network testnet \
  -- get_contract_version
```

**Output:**
```
2
```

### `migrate_meter(meter_id: String) -> Result<(), ContractError>`

**Access:** Admin only  
**Purpose:** Migrate a meter from v0 → v2

**Idempotent:** If the meter is already at v2, this is a no-op

### `migrate_meter_to_v2(meter_id: String) -> Result<(), ContractError>`

**Access:** Admin only  
**Purpose:** Migrate a meter from v1 → v2

**Idempotent:** If the meter is already at v2, this is a no-op

## Future Deprecation Policy

Once a second contract version is shipped to production:

1. The API will continue to support the previous schema version for one major release cycle
2. Deprecation warnings will be added to the health endpoint response
3. A migration grace period (e.g., 90 days) will be announced via release notes
4. After the grace period, the API may drop support for older schema versions

This policy will be formalized once there's a real need to maintain backward compatibility across production deployments.

## References

- [Backend API Documentation](../backend/API.md)
- [OpenAPI Specification](../backend/openapi.yaml)
- [Contract Source](../contracts/solar_grid/src/lib.rs)
- [README - Meter Migration](../README.md#meter-migration)
