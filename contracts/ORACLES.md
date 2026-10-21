# Decentralized Oracle Network (#1052)

Removes the single-oracle point of failure by aggregating price and weather
feeds from multiple staked oracle nodes. Logic lives in
`contracts/solar_grid/src/oracle_network.rs`.

## Round lifecycle
1. Registered nodes (`OracleNode { operator, stake, reputation, rewards }`) submit a value for a feed (`FeedKind::Price | Weather`).
2. `finalize_round` requires at least **3** submissions from nodes with non-zero reputation (quorum).
3. The accepted value is the **median** of eligible submissions (even count → floor-average of the two middle values).

## Slashing & reputation
| Event | Effect |
|---|---|
| Value within **5%** (500 bps) of median | +5 reputation (max 1000), share of rewards |
| Value outside tolerance | 10% of stake slashed, −100 reputation |
| Reputation reaches 0 | Node no longer counts toward quorum or median |

## Incentives
The round's `reward_pool` plus all slashed stake is split equally among honest
nodes, so accurate reporting is rewarded and dishonesty funds honest operators.

## Tests
`cargo test -p solar_grid oracle_network` — median, tolerance, slashing/rewards, quorum, and zero-reputation exclusion.
