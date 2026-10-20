# Meter Performance Benchmarking AI

Implementation: `src/lib/benchmarking.ts`, routes in `src/routes/benchmarking.ts`.

1. **Clustering:** k-means over (lat, lng, capacity, age) groups similar meters.
2. **Outlier detection:** performance ratio = daily kWh / capacity kW; meters with z-score below the threshold (default −1.5) within their cluster are flagged.
3. **Root cause:** heuristics — skewed morning/afternoon ratio → shading; < 50% of cluster mean → faulty panel/inverter; age > 15y → degradation; else soiling.
4. **Recommendations:** each root cause maps to a corrective action.
5. **Improvement tracking:** record a fix with a baseline ratio, then query current improvement %.

| Endpoint | Body / Query |
|---|---|
| `POST /api/benchmarking/analyze` | `{ meters: MeterProfile[], threshold? }` |
| `POST /api/benchmarking/fixes` | `{ meterId, baselineRatio, action }` |
| `GET /api/benchmarking/fixes/:meterId?currentRatio=` | improvement report |
