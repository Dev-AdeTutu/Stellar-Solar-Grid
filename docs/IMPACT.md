# Social Impact Measurement (#1054)

Tracks the social outcomes of solar projects (`backend/src/lib/impact.ts`).

## Metrics
- Households electrified, jobs created, average monthly income before/after, kWh delivered, investment.
- Derived: annual income gain, average income improvement %, CO₂ avoided (0.0007 t/kWh).

## SDG mapping
| SDG | Indicators |
|---|---|
| 7 — Affordable and Clean Energy | households electrified, kWh delivered |
| 8 — Decent Work and Economic Growth | jobs created, annual income gain |
| 13 — Climate Action | CO₂ avoided |

## SROI
`social value / investment`, where social value = households × $180 + jobs × $2,400 + annual income gain + CO₂ t × $51.

## API
| Method | Path | Description |
|---|---|---|
| GET | `/api/impact?projectId=` | Totals, SDG alignment, SROI |
| GET | `/api/impact/report?projectId=` | Investor impact report (incl. latest 5 stories) |
| PUT | `/api/impact/projects/:id` | Upsert project metrics |
| GET | `/api/impact/stories?projectId=` | Impact stories and testimonials |
| POST | `/api/impact/stories` | `{ projectId, author, quote }` |

## Frontend
`/impact` — headline metrics, SDG cards, SROI and testimonials.

## Tests
`backend/tests/issues-1050-1054.integration.test.ts`
