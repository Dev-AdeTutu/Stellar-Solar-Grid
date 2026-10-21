# Predictive Grid Capacity Planning (#1050)

Forecasts per-region capacity needs from meter growth and peak-demand trends.

## Model
- Monthly observations per region (`meters`, `peakKw`) are fit with ordinary least squares (`backend/src/lib/capacityPlanning.ts`).
- Peak demand is projected forward from the fitted trend; the growth slope is scaled by the scenario multiplier.
- A region is a **bottleneck** once projected utilization (`peakKw / capacityKw`) reaches **85%**.
- Recommendations size new capacity so the final projected peak sits at 85% utilization, costed at **$1,200/kW**.
- Priority: ≤3 months → critical, ≤6 high, ≤12 medium, otherwise low.

## Scenarios
| Scenario | Growth multiplier |
|---|---|
| conservative | 0.5× |
| baseline | 1× |
| aggressive | 1.75× |

## Accuracy
`backtestAccuracy` holds out the last 3 months, fits on the rest and reports MAPE (%).

## API
| Method | Path | Description |
|---|---|---|
| GET | `/api/capacity-planning?horizon=24&scenario=baseline` | All region forecasts + investment recommendations |
| GET | `/api/capacity-planning/:region` | Region forecast, bottleneck month per scenario, backtest accuracy |
| POST | `/api/capacity-planning/:region/observations` | `{ month: "YYYY-MM", meters, peakKw }` |
| PUT | `/api/capacity-planning/:region/capacity` | `{ capacityKw }` |

## Frontend
`/capacity-planning` — scenario selector, per-region utilization projections and recommendations.

## Tests
`backend/tests/issues-1050-1054.integration.test.ts`
