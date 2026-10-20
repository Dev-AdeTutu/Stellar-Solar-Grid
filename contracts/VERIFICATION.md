# Formal Verification

Critical arithmetic in the `solar_grid` contract is specified and proved with
the [Kani](https://model-checking.github.io/kani/) bounded model checker, which
checks properties for **every** possible input rather than sampled ones.

## Specified functions (`solar_grid/src/verification.rs`)

| Function | Pre-condition | Proven post-condition |
|---|---|---|
| `credit(balance, amount)` | `balance >= 0`, `amount > 0` | `result = balance + amount`, no overflow, `result >= 0` |
| `debit(balance, amount)` | `0 < amount <= balance` | `result >= 0`, `result + amount = balance` |
| `bps_share(amount, bps)` | `amount >= 0`, `bps <= 10_000` | `0 <= result <= amount`, no overflow |
| `add_units(units, delta)` | — | `result >= units`, no u64 overflow |
| `algo_market::split_fee(fee)` | `0 <= fee <= i128::MAX / 10_000` | `creator + platform = fee`, both `>= 0` |

Out-of-domain inputs return `None`, which callers map to a `ContractError`.

## Invariants

- **Balance non-negativity** — balances can only change through `credit`/`debit`.
- **No overflow** — all additions use checked arithmetic; the release profile
  also sets `overflow-checks = true` as a runtime backstop.
- **Value conservation** — revenue splits never mint or burn value.
- **Batch atomicity** — `execute_batch` either applies every action or none
  (Soroban reverts all storage writes when an invocation returns an error).

## Running locally

```sh
cargo install --locked kani-verifier && cargo kani setup
cd contracts/solar_grid && cargo kani --lib
```

Unit tests mirroring each property run with `cargo test` (module
`verification::tests`).

## CI and reports

`.github/workflows/verification.yml` runs every harness on each PR touching
`contracts/`. Failures block the merge and Kani prints a counter-example trace;
a summary is written to the job's step summary as the verification report.

## Violations addressed

- Fee splits previously had no overflow bound; `split_fee` is now proved
  conservative under an explicit domain assumption.
- Algorithm PnL accumulation uses `checked_add` and reverts with `InvalidAmount`
  on overflow.
