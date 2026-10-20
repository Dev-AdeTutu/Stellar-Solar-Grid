# Meter Lifespan Extension Recommendations (#1079)

Implemented in `src/lib/lifespan.ts`, exposed at `/api/lifespan`.

## How it works

1. **Failure analysis** – failure events (`overheating`, `moisture`, `power_surge`, `relay_wear`, `firmware`, `connectivity`, `other`) are grouped by cause with count, downtime and repair cost.
2. **Preventive schedule** – each cause maps to a catalog action (`GET /api/lifespan/actions`) with an interval, cost, effectiveness and expected life gain. `nextDueAt` is computed from the last completion (or now if never done).
3. **ROI** – `expectedAnnualSavings = annualRepairCost(cause) × effectiveness`, `annualCost = cost × 365 / intervalDays`, `roi = (savings − cost) / cost`.
4. **Prioritisation** – `impactScore = savings + (lifeGainMonths / designLife) × replacementCost`, down-weighted ×0.25 for causes never observed. Recommendations are sorted by score.
5. **Maintenance vs replacement** – compares annual cost of the maintenance plan (plus residual repair cost) with the annualised replacement cost (`METER_REPLACEMENT_COST`, default 250) and remaining life.
6. **Lifespan tracking** – completed actions add pro-rated life gain; each failure subtracts 2 months from a 120-month design life.

## Endpoints

| Method | Path | Body |
|---|---|---|
| GET | `/api/lifespan/:meterId` | — returns `failures`, `recommendations`, `costBenefit`, `lifespan` |
| POST | `/api/lifespan/:meterId/failures` | `{ cause, occurredAt?, downtimeHours?, repairCost? }` |
| POST | `/api/lifespan/:meterId/maintenance` | `{ actionId, completedAt? }` |
| PUT | `/api/lifespan/:meterId/install-date` | `{ installedAt }` |

State is in-memory; persist via a database adapter for production.
