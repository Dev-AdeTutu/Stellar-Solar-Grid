# Governance Voting (#1056)

The DAO contract (`contracts/dao`) supports three voting modes, chosen per proposal:

| Mode | Vote weight |
|------|-------------|
| `TokenWeighted` | `token_amount` |
| `Quadratic` | `isqrt(token_amount)` |
| `TimeWeighted` | `token_amount × (100 + hold_bonus + lock_bonus) / 100` |

## Time-weighted power

- **Hold bonus** — grows linearly from 0 to +100% over `MAX_HOLD_SECONDS` (1 year) of holding.
  Hold age is a token-weighted average acquisition time: topping up a balance blends the new
  tokens in at age 0, so fresh tokens never inherit an old balance's bonus.
- **Lock bonus** — `lock_tokens(voter, amount, duration)` locks up to the voter's balance for up
  to `MAX_LOCK_SECONDS` (4 years). While active, locked tokens get `duration / MAX_LOCK_SECONDS × 100%`
  extra weight. Locks can be extended or increased but never shortened or reduced.
- Maximum power is therefore 3× the token amount.

`voting_power(voter)` returns the current time-weighted power of a voter's full balance.

## Sybil resistance

In `Quadratic` and `TimeWeighted` modes, a voter's hold-since time must be at or before the
proposal's `created_at`. Tokens minted to fresh addresses after a proposal opens cannot vote on it,
which blocks the classic quadratic-voting attack of splitting a balance across new addresses.
The time-weighted bonus is linear in tokens, so splitting gives no advantage there either.

## Tests

```bash
cd contracts/dao && cargo test
```
