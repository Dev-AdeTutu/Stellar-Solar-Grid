# Energy Trading Algorithm Marketplace

## On-chain (contract)

| Function | Who | Description |
|---|---|---|
| `publish_algorithm(creator, name, fee)` | creator | Lists an algorithm, returns its id |
| `set_algorithm_active(id, bool)` | creator | Opens/closes subscriptions |
| `subscribe_algorithm(user, id)` | user | Pays `fee`; 90% to creator, 10% to platform admin |
| `unsubscribe_algorithm(user, id)` | user | Cancels subscription |
| `record_algo_trade(id, pnl)` | oracle | Records an executed trade and realised PnL |
| `get_algorithm`, `list_algorithms`, `is_subscribed` | anyone | Views |

`Algorithm` tracks `subscribers`, `trades`, `total_pnl` and `creator_earnings`,
giving an on-chain performance record. Revenue sharing uses
`algo_market::split_fee`, formally proved to conserve value (see
`VERIFICATION.md`).

## Off-chain execution (`backend/src/algo/engine.ts`)

Strategies are pure functions `(tick, history, position) => signal`, so the
same code drives live trading and backtests.

- `AlgoRunner` feeds market ticks to every subscriber's strategy, executes
  trades against their position (never overspending cash or overselling
  inventory) and reports each trade so the oracle can call `record_algo_trade`.
- `backtest(strategy, ticks)` returns trades plus metrics: `pnl`, `returnPct`,
  `winRate`, `maxDrawdown`.

Built-in strategies: `mean-reversion`, `peak-shaver`.

API: `GET /api/algos/strategies`, `POST /api/algos/backtest { strategy, ticks }`.

## Frontend

`/marketplace` — browse strategies, run backtests, subscribe, publish.

## Tests

- Contract: `batch_and_market_tests` in `solar_grid/src/test.rs`
- Engine: `npm run test:algo` in `backend/`
