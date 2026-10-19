# Contract test suite

The `solar_grid` contract is covered by four layers of tests. All of them run
with `cargo test` from `contracts/` and in the **Contract CI** workflow.

| Layer | Location | What it covers |
|---|---|---|
| Unit tests | `solar_grid/src/lib.rs` (`mod tests`, `mod audit_log_tests`), `src/test_assets_warranty.rs` | Individual entry points, error codes, exact event payloads |
| Integration tests | `solar_grid/tests/*.rs` | Multi-step flows through the public client, one file per area |
| Property-based tests | `solar_grid/tests/properties.rs` | Invariants over randomized inputs ([proptest](https://docs.rs/proptest)) |
| Resource ("gas") tests | `solar_grid/tests/budget.rs` | CPU instruction and ledger-write ceilings for hot paths, mainnet limits |

## Integration suites

| File | Area |
|---|---|
| `admin_governance.rs` | Multisig admin proposals, pause/freeze, oracle, audit log, allowlist |
| `meter_lifecycle.rs` | Registration + metadata, grace period access, deactivation, ownership transfer, v0/v1/v2/v5 schema migration |
| `payments_revenue.rs` | Delegated payments, auto top-up, meter groups, referrals, time-of-use pricing, revenue sharing, refunds, multi-asset |
| `staking.rs` | Staking rewards, reserve cap, cooldown/withdraw/cancel, pause behaviour |
| `emergency_pause.rs`, `reentrancy_allowlist.rs` | Emergency pause and reentrancy/allowlist guards |

Shared fixtures live in `tests/common/mod.rs`. `Fixture::new()` deploys the
contract through its constructor with a Stellar Asset Contract as the payment
token and mocks all authorizations; helpers such as `register_and_fund` and
`advance` keep individual tests short.

## Running

```bash
cd contracts
cargo test --all-targets                 # everything
cargo test --test staking                # one integration suite
cargo test --test properties             # property tests only
PROPTEST_CASES=2000 cargo test --test properties   # deeper fuzzing locally
```

### Coverage

```bash
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov
make coverage          # HTML report in target/llvm-cov/html, fails under 90% lines
```

CI enforces the same line-coverage floor (override with the
`CONTRACT_MIN_LINE_COVERAGE` repository variable) and uploads `lcov.info` as
the `contract-coverage` artifact.

### Windows note

The `cdylib` crate type exports more symbols than the MinGW linker's ordinal
table allows (`export ordinal too large`), and the GNU toolchain ships without
`profiler_builtins`, so integration tests and coverage need Linux, WSL or the
MSVC toolchain. Unit tests (`cargo test --lib`) work everywhere.

## Writing tests

- **Assert typed errors**, not panic strings:
  `assert_eq!(client.try_x(..), Err(Ok(ContractError::Y)))`. For return types
  without `PartialEq`, compare `.err()`.
- **Events** — `env.events().all()` only holds events from the most recent
  top-level invocation, and events of a failed invocation are rolled back.
  Capture them immediately after the call under test.
- **Storage pokes** (e.g. writing a legacy meter layout) must run inside
  `env.as_contract(&client.address, || ..)`.
- **Grace period** — a drained meter stays active for the default 2h grace
  period; call `set_grace_period(&0)` when a test expects immediate
  deactivation.
- **Resource limits** — the test environment enforces mainnet per-transaction
  limits by default. If a test trips them, the operation would also fail on
  the network; fix the operation (or its batch size) rather than disabling the
  limits.

## Resource ceilings

`tests/budget.rs` pins upper bounds measured with native contract execution
(Wasm VM overhead excluded), with ~2x headroom on instructions and exact
bounds on ledger writes:

| Operation | Instructions (measured / ceiling) | Ledger writes |
|---|---|---|
| `register_meter` | ~157k / 350k | 5 |
| `make_payment` | ~419k / 850k | 8 |
| `update_usage` | ~174k / 400k | 3 |
| `check_access` | ~69k / — | 0 |

A usage batch writes two entries per meter, so the network's 50-entry write
limit caps `batch_update_usage` at about 24 meters per transaction even though
the contract accepts up to 200. Submitters should chunk batches accordingly.

## Known gaps

Two unit tests are `#[ignore]`d with a reason, pending maintainer decisions:

- `test_batch_update_usage_with_150_meters_succeeds` — exceeds the network's
  per-transaction ledger limits (see above); the contract's batch cap should
  be lowered.
- `test_incremental_service_extension_on_consecutive_payments` —
  `make_payment` resets expiry to `now + plan period`; the incremental
  extension described in #751 is not implemented.
