# Energy Storage Optimization AI (#1053)

A tabular Q-learning agent (`backend/src/lib/storageOptimizer.ts`) learns when
to **charge**, **discharge** or **idle** a home battery.

## State
`hour | state-of-charge bucket (5) | price level (low/mid/high tercile) | solar surplus flag`

## Reward
`baselineCost − cost + independenceWeight × kWh of grid import avoided`, where
the baseline is the same household with no battery. Defaults: α=0.2, γ=0.9, ε=0.1,
independenceWeight=0.02. Excess solar is stored automatically when there's room.

## Outputs
`plan()` runs the learned greedy policy and returns an hourly control schedule
(the real-time signals sent to the battery), total cost, baseline cost, savings
and grid-independence ratio (`1 − imported / load`).

## API
`POST /api/storage-optimization/plan`
```json
{
  "battery": { "capacityKwh": 10, "maxRateKw": 5, "efficiency": 0.95, "socKwh": 0 },
  "day": [{ "hour": 0, "pricePerKwh": 0.08, "solarKwh": 0, "loadKwh": 1 }],
  "episodes": 500,
  "seed": 42
}
```
Training uses a seeded PRNG so results are reproducible.

## Frontend
`/storage-optimization` — runs a plan for a sample day and shows savings and the schedule.

## Tests
`backend/tests/issues-1050-1054.integration.test.ts`
