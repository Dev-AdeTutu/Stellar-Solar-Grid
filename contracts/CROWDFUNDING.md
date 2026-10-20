# Community Investment Crowdfunding

Contract: `contracts/crowdfunding`. Frontend: `/crowdfund`.

| Function | Description |
|---|---|
| `create_campaign(creator, token, goal, deadline, milestones)` | Milestone amounts must sum to `goal` |
| `contribute(id, contributor, amount)` | Escrows any Stellar asset (XLM, USDC or fiat-anchored stablecoins for fiat on-ramp) |
| `vote(id, milestone, voter, approve)` | Contribution-weighted vote, one per contributor per milestone |
| `release_milestone(id, milestone)` | Releases funds when goal met and >50% of raised weight approves |
| `refund(id, contributor)` | Refund if deadline passed and goal not met |
| `deposit_returns(id, amount)` / `claim_returns(id, contributor)` | Pro-rata ROI distribution |

Build: `cd contracts && cargo build --target wasm32-unknown-unknown --release -p crowdfunding`.
