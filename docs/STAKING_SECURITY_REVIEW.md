# Staking Contract Security Review (#899)

Scope: `contracts/solar_grid/src/staking.rs` and its integration with the rest of
`SolarGridContract`.
Type: internal review by the implementing team, done against the checklist in
[SECURITY_AUDIT_PREP.md](SECURITY_AUDIT_PREP.md). **This is not a third-party
audit.** An independent audit is still recommended before mainnet, since staking
holds user funds.

## Summary

| # | Area | Finding | Status |
| --- | --- | --- | --- |
| 1 | Fund segregation | `emergency_withdraw`, the multisig `EmergencyWithdraw` op and revenue withdrawals transfer the contract's *payment token* balance. If staking used that token, staked funds could be swept. | **Fixed**: `configure_staking` rejects the payment token and any whitelisted payment asset as stake or reward token. |
| 2 | Reward solvency | Rewards could be promised beyond what the contract holds. | **Mitigated by design**: emission is capped at `reward_reserve`, which only increases through actual token transfers in `fund_staking_rewards`. |
| 3 | Rounding | Integer division in the accumulator could leak or strand rewards. | **Mitigated**: only the amount the accumulator actually allocates (`delta * total / SCALE`) leaves the reserve, so dust stays claimable in future periods. Per-user rounding is always down, so total claims ≤ total allocated. |
| 4 | Overflow | `amount * acc_reward_per_share` and `rate * elapsed` in i128. | **Mitigated**: all multiplications use `checked_mul` and return `InvalidAmount` instead of wrapping; the release profile also has `overflow-checks = true`. |
| 5 | Authorization | Every user entry point calls `staker.require_auth()`; configuration requires the admin; funding requires the funder's auth. | OK |
| 6 | Re-entrancy | State is written before every token transfer (checks-effects-interactions). Soroban also forbids re-entrant contract calls, and a failing transfer reverts the whole invocation. | OK |
| 7 | Governance: flash voting power | Voting power is the *current* active stake. Tokens that are cooling down don't count, and a user can't withdraw until the cooldown ends. If the cooldown is shorter than a proposal's voting period, the same tokens could vote, unstake, move to a second account and vote again. | **Operational requirement**: set `cooldown_secs` ≥ the governance voting period (3 days by default), or snapshot voting power at proposal creation when governance is wired on-chain. |
| 8 | Cooldown reset | A second `request_unstake` restarts the cooldown for the whole pending bucket. | **Accepted / documented**: this is conservative (it can't shorten a lock), and `cancel_unstake` lets users back out. |
| 9 | Pause behaviour | `stake` and `cancel_unstake` are blocked while paused; `request_unstake`, `withdraw_unstaked` and `claim_staking_rewards` are not. | **Intended**: users can always exit. The pause stops new exposure. |
| 10 | Admin powers | The admin can change `reward_rate` (existing accruals are settled at the old rate first) and `cooldown_secs` (capped at 90 days). The admin cannot move staked tokens through staking functions, and can't switch tokens once staking has activity. | OK. The 90-day cap prevents trapping funds with an extreme cooldown. |
| 11 | Storage | Positions live in persistent storage keyed by address; empty positions are removed. Pool and config live in instance storage. | OK. Monitor TTL extension like other persistent entries. |
| 12 | Fee-on-transfer / rebasing tokens | Accounting assumes the token transfers exactly `amount`. | **Requirement**: use a standard SEP-41 token. |

## Invariants

Tests should target these invariants:

1. `sum(position.amount) == pool.total_staked`
2. `stake_token.balance(contract) >= total_staked + sum(unstaking.amount)` (+ `reward_reserve` + unclaimed rewards when stake token == reward token)
3. `reward_token.balance(contract) >= reward_reserve + sum(unclaimed rewards)`
4. `pool.total_distributed` never decreases, and `reward_reserve` never goes negative
5. `get_voting_power(a) == position(a).amount`, and `sum(voting power) == get_total_voting_power()`

## Recommendations before mainnet

- Commission an independent audit of `staking.rs` together with `lib.rs` pause and withdrawal paths.
- Property-based tests for the invariants above over random stake/unstake/claim/fund sequences.
- Set `cooldown_secs` according to finding 7.
