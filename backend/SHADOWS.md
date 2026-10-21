# Meter Shadow State (#1081)

Implemented in `src/lib/shadows.ts`, exposed at `/api/shadows`. Follows the device-shadow pattern.

- **desired** – what the backend/user wants (e.g. `{ "relay": "on", "tariff": "peak" }`).
- **reported** – what the meter last reported.
- **delta** – desired keys whose value differs from reported; pushed to the device on reconnect.

Setting a key to `null` removes it.

## Sync flow

1. Meter offline → `PATCH /desired` updates accumulate (`pending: true`).
2. Meter reconnects → `POST /sync` returns `delta`; the bridge sends it to the device.
3. Device applies and calls `PATCH /reported`; the delta shrinks to `{}`.

## Conflict resolution

When a reported value differs from a desired value for the same key, `?strategy=` decides:

| Strategy | Behaviour |
|---|---|
| `desired_wins` (default) | Keep desired; device must converge. |
| `reported_wins` | Adopt device value into desired (manual override at meter). |
| `latest_wins` | Most recently written side wins (per-key timestamps). |

Each resolution is logged as a `conflict` history entry.

## History

Every change increments `version` and is appended to history (`desired`, `reported`, `sync`, `conflict`), capped at 500 entries per meter. `GET /api/shadows/:meterId/history?limit=100` returns newest first.

## Endpoints

`GET /:meterId`, `PATCH /:meterId/desired`, `PATCH /:meterId/reported`, `POST /:meterId/sync`, `POST /:meterId/offline`, `GET /:meterId/history`.

Frontend: `/shadows` shows desired and reported state side by side with the delta highlighted.
