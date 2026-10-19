---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Potential SQL injection in meter notes endpoint"
labels: bug, security
assignees: ''
---

## Describe the Bug

The `meterNotes.ts` module constructs SQL queries using string interpolation with user-provided `meter_id` values. This could allow SQL injection if meter IDs contain malicious SQL syntax.

## Steps to Reproduce

1. Register meter with ID containing SQL: `METER1'; DROP TABLE notes; --`
2. Call `POST /api/meters/:id/notes` with the malicious meter ID
3. Observe SQL query execution behavior

## Expected Behavior

All database queries should use parameterized statements or prepared statements. Better-sqlite3 supports parameter binding with `?` placeholders.

## Actual Behavior

Potential for SQL injection if meter IDs are not properly validated before database operations.

## Screenshots / Logs

```typescript
// Vulnerable pattern (example):
const query = `SELECT * FROM notes WHERE meter_id = '${meter_id}'`;
db.prepare(query).all();
```

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 |
| Node.js version | 20.14.2 |
| better-sqlite3 version | 11.10.0 |
| Network | testnet |

## Additional Context

Audit all database operations in the codebase for proper parameterization. This is a critical security issue.
