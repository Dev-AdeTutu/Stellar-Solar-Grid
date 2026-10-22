# Gamified Energy Challenges (#1059)

Time-limited challenges that reward users for cutting energy usage, e.g.
**"Reduce peak usage 20% this week"**.

## Concepts
| Field | Meaning |
|---|---|
| `metric` | `peak_reduction` (max single reading vs. baseline) or `total_reduction` (sum of readings vs. baseline) |
| `targetPct` | Reduction a participant must reach to be prize-eligible |
| `startsAt` / `endsAt` | Challenge window; status is derived (`scheduled` → `active` → `completed`) |
| `prizes` | XLM amounts by rank — `[100, 50]` pays 1st and 2nd place |

Performance = `(baseline − observed) / baseline × 100`, rounded to 2 decimals.
Ties are broken by meter id for deterministic ranking.

## Prize distribution
When a challenge closes (`POST /:id/finalize` or the scheduler, every 60s, once `endsAt` passes),
participants who met `targetPct` are ranked and paid `prizes[rank-1]`. Finalizing is idempotent —
a completed challenge returns its stored awards without paying again. Failed payouts are recorded
with `status: "failed"` and the error message.

The payer is injected via `createChallengesRouter(pay)` / `startChallengeScheduler(pay)`; the default
logs payouts — wire it to the treasury payment service in production.

## API (`/api/challenges`)
| Method | Path | Auth | Body |
|---|---|---|---|
| GET | `/` | – | |
| POST | `/` | admin | `{ name, metric, targetPct, startsAt, endsAt, prizes }` |
| GET | `/:id` | – | |
| GET | `/:id/leaderboard` | – | |
| GET | `/:id/progress/:meterId` | – | |
| GET | `/:id/prizes` | – | |
| POST | `/:id/join` | – | `{ meterId, stellarAddress, baseline }` |
| POST | `/:id/usage` | – | `{ meterId, kwh }` |
| POST | `/:id/finalize` | admin | |

## Frontend
`frontend/src/components/ChallengeBoard.tsx` lists challenges, shows the leaderboard and
the current user's progress bar (pass `meterId`).

## Tests
`backend/tests/challenges.integration.test.ts` — validation, ranking, total/peak metrics,
window enforcement, prize eligibility, idempotent payout and failure recording.
