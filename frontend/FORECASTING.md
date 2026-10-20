# Energy Forecasting Dashboard (#1082)

Page: `/forecasting` (`src/app/forecasting/page.tsx`). Backend: `GET /api/forecast-dashboard/:meterId?lat=&lon=` (`backend/src/lib/forecastDashboard.ts`).

## Model

- **Baseline** – mean and standard deviation of the last 28 daily actuals per meter (defaults: 12 kWh generation, 10 kWh consumption when no history).
- **Weather adjustment** – when `lat`/`lon` are supplied, each day's generation is scaled by `weatherProductionFactor(cloud, temp)` relative to a typical day; consumption rises 3% per °C away from 21 °C. Days without weather data use the baseline and are flagged `weatherAdjusted: false`.
- **Confidence intervals** – 95%: `value ± 1.96·σ·√(1 + h/7)` for horizon `h` days, clamped at 0.
- **Forecast vs actual** – every issued forecast is snapshotted; record actuals with `POST /api/forecast-dashboard/:meterId/actuals` `{ date, generationKwh, consumptionKwh }`. `/compare` returns per-day rows plus MAPE and interval coverage.

## UI

- Meter ID + optional latitude/longitude inputs.
- Two SVG charts (generation, consumption) with the shaded confidence band and the forecast line.
- Table of daily values, net kWh and weather condition.
- Forecast vs actual table and accuracy metrics.
- Auto-refresh every 5 minutes for real-time updates.
