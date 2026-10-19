# Security Audit Preparation

## Scope and security posture

This document prepares the Stellar Solar Grid Soroban contract for an independent security review. The contract holds the platform token balance for registered meters, records meter ownership and usage state, and authorizes administrative and oracle-driven state transitions. The review should treat this document as an inventory and verification plan rather than as evidence that the contract is secure.

## Trust boundaries and assumptions

The contract runs on the Stellar network and inherits consensus, authorization, and host-function guarantees from Soroban. The contract administrator is trusted to configure pricing, grace periods, allowlists, oracle settings, and emergency controls. The usage oracle is trusted to submit correct meter readings and costs; the contract validates signers and arithmetic constraints but cannot independently measure physical electricity consumption. Meter owners are assumed to control their Stellar accounts and are responsible for protecting signing keys.

The backend is an untrusted intermediary from the contract’s perspective. It builds transactions and queries state, but contract authorization must remain the final control. Off-chain payment history, receipts, webhooks, and QR metadata are derived records and must not be treated as authoritative when they disagree with on-chain state.

## Contract function inventory

| Function group | Functions | Security considerations |
|---|---|---|
| Initialization and administration | `initialize`, `set_admin`, `propose_admin`, `accept_admin`, `set_multisig_threshold` | Initialization must be one-time or explicitly protected. Admin rotation and multisig approval flows must prevent unauthorized takeover and replay. |
| Meter lifecycle | `register_meter`, `register_meters_batch`, `set_active`, `transfer_meter`, `migrate_meter` | Ownership, allowlist checks, duplicate IDs, migration version checks, and batch-size limits must be enforced consistently. |
| Payments and refunds | `make_payment`, `refund_payment`, `withdraw_revenue`, `emergency_withdraw` | Verify authorization, positive amounts, balance accounting, refund ceilings, token contract identity, and reentrancy-resistant state ordering. |
| Usage accounting | `update_usage`, `batch_update_usage`, `compute_cost`, `set_daily_limit`, `set_cap_mode` | The oracle is privileged. Check arithmetic saturation, negative-cost rejection, daily limits, inactive meters, and balance depletion. |
| Pricing and policy | `set_unit_price`, `get_unit_price`, `set_pricing_schedule`, `get_current_rate` | Only administrators may mutate schedules. Validate non-overlapping windows, valid rates, day-of-week handling, and deterministic UTC interpretation. |
| Access and safety | `check_access`, `check_access_status`, `pause`, `unpause`, `freeze`, `unfreeze` | Emergency controls can deny service globally. Verify authorization, expiry behavior, and safe recovery paths. |
| Read-only queries | `get_meter`, `get_meter_full`, `get_meter_balance`, `get_all_meters`, `get_meters_by_owner` | Confirm that query failures and missing records do not produce unsafe defaults in callers. |

## Administrative privileges and risks

The admin can configure the contract’s economic parameters, authorize usage updates, manage meter registration, change administrative ownership, pause or freeze operations, and withdraw revenue. A compromised admin key can therefore alter prices, drain available revenue, create or deactivate meters, or deny service. Admin keys must be held in a hardware-backed or multisignature workflow, rotated through the contract’s supported procedure, and excluded from application logs and CI variables except during controlled deployment.

The oracle privilege is narrower but still material. A compromised oracle can submit false usage and costs, exhaust customer balances, or trigger deactivation. Oracle credentials should be isolated from admin credentials. The backend must not expose a route that allows arbitrary callers to impersonate the oracle.

## Attack surface analysis

The principal attack surfaces are authorization checks, token transfer and refund accounting, admin and oracle key compromise, contract upgrade and migration paths, arithmetic and timestamp boundaries, unbounded storage growth, and off-chain assumptions about event ordering. Batch APIs require explicit size limits and per-item failure handling. Persistent meter records require versioned migration tests whenever fields change. Time-based pricing must use ledger timestamps and UTC day boundaries so local timezone changes cannot alter billing.

External integrations add additional surfaces. The backend must validate Stellar addresses and meter identifiers before constructing contract arguments. Receipt storage must not permit path traversal or overwrite another payment’s file. QR payloads must be treated as untrusted input and validated before they populate a registration form. Webhook and email delivery must not block or roll back a confirmed on-chain payment.

## Known limitations and open TODOs

The physical meter and usage oracle are outside the contract’s trust domain. The contract cannot prove that an oracle reading matches real-world consumption. Off-chain receipts are generated after confirmation and are not themselves on-chain attestations. QR codes identify registration data but do not grant authorization. The current audit preparation does not replace a formal dependency review of Soroban SDK, token contract, RPC provider, MQTT broker, or frontend camera permissions.

Before an external audit, the project should add property-based tests for payment/refund conservation, fuzz schedule windows and timestamp boundaries, run static analysis and dependency scanning in CI, document the deployed contract ID and WASM hash, and define an incident response procedure for admin or oracle key compromise.

## Test coverage evidence

Run the contract test suite from the repository root with:

```bash
cd contracts
cargo test -p solar_grid
```

The audit package should include the resulting report, the compiler and Rust toolchain versions, the deployed WASM SHA-256, and coverage generated by the project’s chosen Rust coverage tool. The required minimum review set includes authorization tests for every admin and oracle function, duplicate and malformed meter tests, arithmetic boundary tests, pause/freeze tests, migration tests, refund conservation tests, and weekday/weekend pricing schedule tests.

## Pre-audit checklist

- [ ] Freeze the audited commit and record its Git SHA.
- [ ] Record the Soroban SDK, Rust toolchain, network, contract ID, and WASM hash.
- [ ] Confirm admin and oracle keys are separate and stored outside source control.
- [ ] Run unit, integration, negative, migration, and schedule boundary tests.
- [ ] Generate and archive the test coverage report.
- [ ] Review all `TODO`, `FIXME`, unsafe, unchecked conversion, and host-call sites.
- [ ] Test deployment, upgrade, pause, unpause, and emergency recovery on testnet.
- [ ] Provide the auditor with this document, contract source, build instructions, and reproducible fixtures.
