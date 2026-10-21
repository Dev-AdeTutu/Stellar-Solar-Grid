# Meter Co-Ownership

## Overview

The co-ownership feature allows a single meter to be owned by multiple addresses, each holding a configurable share of the meter. This enables shared investments, cooperatives, and joint ventures where several parties contribute to and benefit from a single energy meter.

Shares are expressed as integer weights. The total of all shares for a meter defines the denominator used for all proportional calculations (cost sharing, revenue sharing, and voting). Shares do not need to sum to a fixed value (e.g. 100); they are normalized against the current total.

## Share Model

- Each meter maintains a mapping of `owner => share`.
- A meter has a `total_shares` value equal to the sum of all owners' shares.
- An owner's percentage of the meter is `share / total_shares`.
- Shares are non-negative integers. A share of `0` means the address is not an owner.
- The sum of all shares must always be greater than zero for a meter that has owners.

Example:

| Owner   | Share | Percentage |
|---------|-------|------------|
| Alice   | 60    | 60%        |
| Bob     | 30    | 30%        |
| Carol   | 10    | 10%        |
| Total   | 100   | 100%       |

## Proportional Cost Sharing

Usage costs for a meter are split among co-owners in proportion to their shares.

For a cost `C` and owner with share `s` out of `total_shares`:

```
owner_cost = C * s / total_shares
```

Remainder handling: integer division may leave a remainder. The remainder is assigned to the largest shareholder (or distributed deterministically) so that the sum of individual costs always equals the total cost. Implementations should document their remainder policy; the reference implementation assigns any remainder to the owner with the largest share, breaking ties by lowest address.

## Proportional Revenue Sharing

Revenue from energy exports is distributed to co-owners in proportion to their shares, using the same formula as cost sharing:

```
owner_revenue = R * s / total_shares
```

The same remainder policy applies so that distributed revenue always equals total revenue.

## Ownership-Weighted Voting

Governance decisions for a meter (e.g. approving upgrades, changing tariffs, adding/removing owners) are decided by ownership-weighted voting.

- Each owner's vote weight equals their share.
- A proposal passes when the sum of shares voting "yes" exceeds a configurable threshold of `total_shares` (e.g. a simple majority `> 50%`, or a supermajority).
- Only current owners at the time of voting may vote.
- Each owner may vote at most once per proposal.

Example with a 50% threshold and 100 total shares: a proposal needs more than 50 shares of "yes" votes to pass.

## Share Transfer Rules

- An owner may transfer all or part of their share to another address.
- The sender must hold at least the transferred amount.
- Transfers update both owners' shares and keep `total_shares` constant.
- Transferring the entirety of an owner's share removes them from the owner set (their share becomes `0`).
- Transfers to the zero address are rejected.
- Transfers that would reduce an owner below any configured minimum (if enabled) are rejected.
- Optionally, transfers may require governance approval depending on meter configuration.

## API / Contract Usage

The following illustrates the expected contract interface. Exact names may vary by implementation.

### Adding co-owners

```rust
// Set initial co-owners and their shares when configuring a meter.
meter.set_co_owners(vec![
    (alice, 60),
    (bob, 30),
    (carol, 10),
]);
```

### Querying shares

```rust
let share = meter.share_of(&alice);        // 60
let total = meter.total_shares();          // 100
let pct   = meter.ownership_percentage(&alice); // 60 (percent)
```

### Transferring shares

```rust
// Alice transfers 10 shares to Dave.
meter.transfer_shares(&alice, &dave, 10)?;
// Alice now holds 50, Dave holds 10, total remains 100.
```

### Distributing costs and revenue

```rust
// Split a usage cost of 1000 among co-owners.
meter.distribute_cost(1000)?;
// Alice: 600, Bob: 300, Carol: 100

// Distribute export revenue of 500 among co-owners.
meter.distribute_revenue(500)?;
// Alice: 300, Bob: 150, Carol: 50
```

### Governance voting

```rust
let proposal_id = meter.create_proposal(ProposalAction::ChangeTariff(new_tariff))?;
meter.vote(&proposal_id, &alice, true)?; // weight = 60
meter.vote(&proposal_id, &bob, true)?;   // weight = 30 -> total yes = 90
let passed = meter.tally(&proposal_id)?; // true if threshold met
```

## Events

Implementations should emit events for observability:

- `CoOwnersSet { meter, owners }`
- `SharesTransferred { meter, from, to, amount }`
- `CostDistributed { meter, total, per_owner }`
- `RevenueDistributed { meter, total, per_owner }`
- `ProposalCreated { meter, proposal_id, action }`
- `VoteCast { meter, proposal_id, voter, support, weight }`
- `ProposalExecuted { meter, proposal_id, passed }`

## Security Considerations

- Validate that `total_shares > 0` before any distribution or vote.
- Guard against overflow when computing `amount * share`; use checked arithmetic or widen to a larger integer type before dividing.
- Ensure remainder assignment is deterministic and conserves totals.
- Restrict share transfers and governance actions to authorized owners.
- Emit events for all state-changing operations.

## Testing

Tests should cover:

- Setting co-owners and verifying shares and totals.
- Proportional cost and revenue distribution, including remainder handling.
- Ownership-weighted voting with passing and failing thresholds.
- Share transfers (partial, full, invalid amounts, zero address).
- Access control for transfers and voting.
- Edge cases: single owner, zero shares, large share values.