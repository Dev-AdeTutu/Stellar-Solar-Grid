# Regulatory Sandbox Mode

## Overview

Regulatory Sandbox Mode provides an isolated environment for safely testing regulatory-sensitive features before promoting them to production. It prevents experimental code from affecting production compliance, audit trails, or real customer data.

The sandbox is built around three pillars:

1. **Isolated sandbox environment** — a separate execution context with its own configuration, data store, and compliance state.
2. **Feature flags** — experimental features are gated behind flags that are disabled by default in production.
3. **Synthetic test data generation** — realistic but non-sensitive data for exercising regulatory flows.

## Architecture

```
┌─────────────────────────────────────────────┐
│                 Application                 │
│                                             │
│  ┌───────────────┐      ┌────────────────┐  │
│  │  Production   │      │    Sandbox     │  │
│  │  Environment  │      │  Environment   │  │
│  │               │      │                │  │
│  │ - Real data   │      │ - Synthetic    │  │
│  │ - Compliance  │      │   data         │  │
│  │   enforced    │      │ - Compliance   │  │
│  │ - Audit trail │      │   simulated    │  │
│  │               │      │ - Isolated     │  │
│  │               │      │   audit trail  │  │
│  └───────────────┘      └────────────────┘  │
│          ▲                      ▲           │
│          │                      │           │
│     Feature Flags ◄─────────────┘           │
└─────────────────────────────────────────────┘
```

The sandbox never shares mutable state with production. Any write performed in sandbox mode is routed to the sandbox store and never reaches production systems.

## Enabling Sandbox Mode

Sandbox mode is controlled by the `SANDBOX_MODE` environment variable (or the equivalent configuration key):

```bash
SANDBOX_MODE=true
```

When enabled:

- All data access is redirected to the sandbox data store.
- Compliance checks run in **simulation** mode — violations are recorded but do not block or emit production alerts.
- Audit entries are tagged with `environment: sandbox` and stored separately.
- Outbound integrations (regulatory reporting, notifications) are stubbed.

> **Warning:** Never enable sandbox mode in a production deployment that serves real customers. Sandbox mode is intended for dedicated sandbox deployments or local/test environments.

## Feature Flags

Experimental regulatory features must be gated behind feature flags. Flags are defined with a default state and can be overridden per environment.

### Defining a flag

```python
from app.sandbox.flags import FeatureFlag, flag_registry

flag_registry.register(
    FeatureFlag(
        name="new_kyc_workflow",
        description="Experimental KYC verification workflow",
        default_enabled=False,
        sandbox_only=True,
    )
)
```

### Checking a flag

```python
from app.sandbox.flags import is_enabled

if is_enabled("new_kyc_workflow"):
    run_experimental_kyc()
else:
    run_stable_kyc()
```

### Flag semantics

| Property        | Meaning                                                        |
|-----------------|----------------------------------------------------------------|
| `default_enabled` | State when no override exists. Defaults to `False`.          |
| `sandbox_only`  | If `True`, the flag can never be enabled outside sandbox mode. |
| `overrides`     | Per-environment overrides (e.g. `{"sandbox": True}`).          |

Flags marked `sandbox_only` are hard-blocked in production: attempting to enable them raises a configuration error at startup.

## Synthetic Test Data Generation

The sandbox includes a synthetic data generator that produces realistic but entirely fictional records for regulatory flows (customers, transactions, KYC documents, reports).

```python
from app.sandbox.data import SyntheticDataGenerator

gen = SyntheticDataGenerator(seed=42)
customers = gen.customers(count=100)
transactions = gen.transactions(customer_ids=[c.id for c in customers], count=1000)
```

### Guarantees

- **Deterministic** when a `seed` is supplied — reproducible test runs.
- **No real PII** — all names, identifiers, and account numbers are generated from synthetic pools.
- **Schema-compatible** — generated records conform to production schemas so code paths behave identically.
- **Clearly marked** — every synthetic record carries `is_synthetic: true` and a `sandbox_` prefixed identifier.

Synthetic data must never be copied into production stores. The generator refuses to run when `SANDBOX_MODE` is not enabled.

## Compliance Isolation

Compliance isolation ensures sandbox activity cannot influence production compliance outcomes.

- **Separate stores:** sandbox data, audit logs, and compliance state live in dedicated storage namespaces.
- **Simulated enforcement:** compliance rules execute in dry-run mode; violations are logged to the sandbox audit trail only.
- **No external side effects:** regulatory submissions, customer notifications, and webhooks are stubbed in sandbox mode.
- **Tagged audit trail:** all sandbox audit entries include `environment: sandbox` for easy filtering and cleanup.
- **Guard rails:** production-only operations (e.g. filing a regulatory report) raise `SandboxViolationError` when invoked in sandbox mode.

### Isolation invariants

1. No sandbox write may target a production store.
2. No production compliance decision may read sandbox state.
3. Sandbox audit entries are never merged into the production audit trail.
4. `sandbox_only` flags cannot be enabled outside sandbox mode.

## Promotion Workflow

Promoting a feature from sandbox to production follows a controlled path:

1. **Develop in sandbox** — implement the feature behind a `sandbox_only` flag.
2. **Validate** — run the full test suite plus sandbox isolation tests (see below).
3. **Review** — compliance and engineering review the sandbox audit trail and test results.
4. **Flip the flag definition** — remove `sandbox_only=True` and set an explicit production override once approved:
   ```python
   flag_registry.update("new_kyc_workflow", sandbox_only=False)
   ```
5. **Gradual rollout** — enable the flag for a small production cohort, monitor compliance metrics.
6. **Full rollout** — enable for all production traffic and remove the legacy code path.

Each promotion step should be recorded in the change log with a link to the sandbox validation run.

## Running Isolation Tests

Isolation tests verify that sandbox mode cannot leak into production state. Run them with:

```bash
pytest tests/sandbox/ -v
```

Key test suites:

| Test file                              | Verifies                                              |
|----------------------------------------|-------------------------------------------------------|
| `test_sandbox_isolation.py`            | Sandbox writes never reach production stores.         |
| `test_feature_flags.py`                | `sandbox_only` flags are blocked in production.       |
| `test_synthetic_data.py`               | Generator is deterministic and produces no real PII.  |
| `test_compliance_isolation.py`         | Compliance decisions are isolated and audit-tagged.   |

These tests run in CI on every change and must pass before any sandbox feature can be promoted.

## Configuration Reference

| Key                    | Default | Description                                    |
|------------------------|---------|------------------------------------------------|
| `SANDBOX_MODE`         | `false` | Enables the isolated sandbox environment.      |
| `SANDBOX_DATA_STORE`   | `sandbox` | Namespace for sandbox data.                  |
| `SANDBOX_AUDIT_STORE`  | `sandbox_audit` | Namespace for sandbox audit entries.   |
| `SANDBOX_SEED`         | unset   | Seed for deterministic synthetic data.         |

## Troubleshooting

- **`SandboxViolationError`** — a production-only operation was attempted in sandbox mode. This is expected; guard the call with `is_enabled(...)` or an environment check.
- **Flag not taking effect** — confirm the flag is registered and that `sandbox_only` is not blocking it in the current environment.
- **Non-deterministic data** — set `SANDBOX_SEED` to a fixed value.