# Energy Trading Competitions (#903)

Monthly competitions with automatic XLM prizes. The web UI is at `/competitions`.

## Competition types

| Type | Score (higher wins) | Data source |
| --- | --- | --- |
| `efficiency` | % reduction in average daily consumption vs. a baseline window of equal length just before the start | Recorded usage events (automatic) |
| `trading` | Total units traded | `POST /api/competitions/:id/scores` from the trading engine |
| `green_energy` | Total renewable units used | `POST /api/competitions/:id/scores` from IoT / oracle |

Ties go to whoever joined first. An efficiency participant needs at least `minBaselineUnits` of baseline usage to be
ranked, which stops brand-new meters from scoring an automatic 100%.

## Lifecycle

```
scheduled ──(starts_at)──▶ active ──(ends_at)──▶ completed ──▶ prizes paid
                                  └──(fewer than minParticipants scored)──▶ cancelled
```

- **Monthly scheduling.** Every 5 minutes the scheduler makes sure this month has one competition per type in
  `COMPETITION_MONTHLY_TYPES`, with a unique `schedule_key` such as `monthly:efficiency:2026-10`. It also activates
  competitions that have started and finalizes those that have ended.
- **Finalization.** The leaderboard is frozen and a prize row is created per paid rank.
- **Prize distribution.** When `COMPETITION_PAYOUTS_ENABLED=true`, prizes are sent as XLM payments from the admin
  account to the winner's registered address. A prize is marked `processing` before submission, so a crash
  mid-payment is never retried automatically and can't pay a winner twice. `failed` payouts are retried on each tick,
  or on demand with `POST /:id/prizes/retry`.
- **Joining.** Only the meter's on-chain owner can join, verified against `get_meter`, and prizes go to that address.

## Configurable rules

Set at creation or with `PATCH /api/competitions/:id` until the competition completes:

```json
{
  "prizes": [500000000, 250000000, 100000000],
  "minParticipants": 3,
  "maxParticipants": null,
  "minBaselineUnits": 1
}
```

`prizes` are stroops per rank; index 0 is 1st place. Defaults come from `COMPETITION_DEFAULT_PRIZES_XLM`,
`COMPETITION_MIN_PARTICIPANTS` and `COMPETITION_MAX_PARTICIPANTS`.

## Real-time leaderboards

`GET /api/competitions/:id/leaderboard/stream` is a Server-Sent Events stream (`event: leaderboard`). It pushes
immediately on joins and score submissions, and every `COMPETITION_LIVE_REFRESH_MS` (default 15 s) while usage-based
scores change. Unchanged boards are not re-sent.

## Participation metrics

- `GET /api/competitions/:id/metrics` returns participants, scored participants, score entries and joins per day.
- `GET /api/competitions/metrics` returns totals across all competitions: competitions by status, total entries,
  unique participants, repeat participants, average participants per competition, and prizes paid (count and amount).

## API

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/competitions?status=&type=` | — |
| GET | `/api/competitions/:id` | — |
| GET | `/api/competitions/:id/leaderboard` · `/leaderboard/stream` | — |
| POST | `/api/competitions/:id/join` — `{ meterId, stellarAddress, displayName? }` | meter owner |
| DELETE | `/api/competitions/:id/participants/:meterId` | — |
| POST | `/api/competitions` — `{ name, type, startsAt, endsAt, rules? }` | admin |
| PATCH | `/api/competitions/:id` — `{ name?, endsAt?, rules? }` | admin |
| POST | `/api/competitions/:id/cancel` · `/finalize` · `/prizes/retry` | admin |
| POST | `/api/competitions/:id/scores` — `{ meterId, value, recordedAt? }` | admin |
