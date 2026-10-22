# Multi-Tenant Data Isolation

This document describes the multi-tenant data isolation model used by the backend. All providers share a single database, but data is strictly partitioned by `provider_id` so that no provider can read or write another provider's data.

## Overview

- **Tenant key:** every tenant is identified by `provider_id`.
- **Scoping:** every tenant-owned table carries a `provider_id` column and all queries are scoped to the authenticated tenant.
- **Defense in depth:** isolation is enforced at three layers:
  1. **Application layer** — tenant middleware resolves the tenant and scopes all queries.
  2. **Database layer** — PostgreSQL Row-Level Security (RLS) policies reject any row that does not match the current tenant.
  3. **Audit layer** — every tenant-scoped operation is recorded in a tenant-scoped audit trail.

## Provider ID Scoping Across Tables

Every table that stores tenant-owned data includes a non-null `provider_id` column:

| Table | Tenant column | Notes |
| --- | --- | --- |
| `providers` | `id` | Root tenant record; `id` is the tenant key. |
| `users` | `provider_id` | Users belong to exactly one provider. |
| `appointments` | `provider_id` | Scoped to owning provider. |
| `patients` | `provider_id` | Scoped to owning provider. |
| `prescriptions` | `provider_id` | Scoped to owning provider. |
| `invoices` | `provider_id` | Scoped to owning provider. |
| `audit_logs` | `provider_id` | Tenant-scoped audit trail. |

Rules:

- `provider_id` is `NOT NULL` on all tenant-owned tables.
- Foreign keys that reference tenant-owned rows must include the tenant column so cross-tenant references are impossible.
- Composite indexes lead with `provider_id` (e.g. `(provider_id, created_at)`) to keep tenant-scoped queries fast.
- Application code must never issue a query against a tenant-owned table without a `provider_id` predicate. The tenant middleware and repository layer enforce this automatically.

## Row-Level Security Policies

RLS is enabled and forced on every tenant-owned table. Policies compare the row's `provider_id` against the session variable `app.current_provider_id`, which is set per request/transaction by the tenant middleware.

### Enabling RLS

```sql
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
```

`FORCE ROW LEVEL SECURITY` ensures the table owner is also subject to policies, preventing accidental bypass.

### Policy definition

Each tenant-owned table gets a policy of the following shape:

```sql
CREATE POLICY tenant_isolation ON appointments
  USING (provider_id = current_setting('app.current_provider_id', true)::uuid)
  WITH CHECK (provider_id = current_setting('app.current_provider_id', true)::uuid);
```

- `USING` blocks reads of rows belonging to other tenants.
- `WITH CHECK` blocks inserts/updates that would write a row for another tenant.
- `current_setting(..., true)` returns `NULL` when unset, so a missing tenant context matches no rows (fail-closed).

### Migration

The RLS setup lives in a dedicated migration (e.g. `migrations/xxxx_enable_tenant_rls.sql`) that:

1. Adds `provider_id` (with backfill) to any tenant-owned table that lacks it.
2. Enables and forces RLS on each tenant-owned table.
3. Creates the `tenant_isolation` policy on each table.
4. Creates the `app.current_provider_id` setting usage and supporting indexes.

The migration is idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS` before `CREATE POLICY`) so it can be re-run safely.

## Tenant Middleware Behavior

The tenant middleware runs on every authenticated request and establishes the tenant context:

1. **Authenticate** the request and extract the caller's `provider_id` from the verified token/session.
2. **Reject** requests with no resolvable tenant (`401`/`403`) — there is no "default tenant".
3. **Open a transaction** and set the tenant context for the connection:
   ```sql
   SET LOCAL app.current_provider_id = '<provider_id>';
   ```
   `SET LOCAL` scopes the setting to the current transaction, so pooled connections cannot leak tenant context between requests.
4. **Scope queries:** the repository/data-access layer automatically adds `provider_id = :currentProviderId` to all tenant-owned queries as a second line of defense alongside RLS.
5. **Reset on completion:** the transaction commits or rolls back, which clears the `LOCAL` setting.

Because the setting is transaction-local, connection pooling is safe: a connection returned to the pool never carries a previous request's tenant context.

## Tenant-Scoped Audit Trail

All tenant-owned operations are recorded in `audit_logs`, which is itself tenant-scoped:

| Column | Description |
| --- | --- |
| `id` | Primary key. |
| `provider_id` | Tenant the event belongs to (RLS-protected). |
| `actor_id` | User who performed the action. |
| `action` | Operation performed (e.g. `appointment.create`). |
| `entity_type` / `entity_id` | Target of the operation. |
| `metadata` | Additional structured context (JSON). |
| `created_at` | Timestamp. |

- Audit rows are written within the same transaction as the operation they describe, so they cannot be lost or attributed to the wrong tenant.
- `audit_logs` has the same `tenant_isolation` RLS policy, so a provider can only read its own audit trail.
- Isolation-relevant events (e.g. rejected cross-tenant access attempts) are also recorded to provide a tenant isolation audit trail.

## Performance Testing with Isolation

Isolation must not come at an unacceptable performance cost. The performance test suite:

- Seeds multiple tenants with representative data volumes.
- Measures query latency with RLS enabled and tenant context set.
- Verifies that tenant-scoped queries use the `(provider_id, ...)` indexes (via `EXPLAIN`).
- Compares throughput against a baseline to catch regressions introduced by RLS or middleware overhead.

Run the performance suite with:

```bash
npm run test:perf -- --grep "tenant isolation"
```

## Running the Isolation Tests

The isolation test suite verifies that no cross-tenant data access is possible:

- A tenant cannot read, update, or delete another tenant's rows.
- Inserts with a mismatched `provider_id` are rejected by `WITH CHECK`.
- Requests without tenant context fail closed (return no rows / are rejected).
- Audit entries are only visible to their owning tenant.

Run the isolation tests with:

```bash
npm run test:isolation
```

Or as part of the full test run:

```bash
npm test
```

## Summary of Guarantees

- ✅ Separate data by `provider_id` across all tenant-owned tables.
- ✅ Row-level security policies enforced (and forced) on every tenant-owned table.
- ✅ No cross-tenant data access possible (application scoping + RLS + fail-closed context).
- ✅ Tenant isolation audit trail via tenant-scoped `audit_logs`.
- ✅ Performance testing with isolation enabled.
- ✅ Automated tests for data isolation.