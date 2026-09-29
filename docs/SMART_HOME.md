# Smart Home Integration — Google Home & Alexa (#904)

Owners can switch their meters on and off, run energy routines and hear their balance by voice.

| Say | What happens |
| --- | --- |
| "Hey Google, turn off the shop meter" / "Alexa, turn off the shop meter" | Meter relay OFF |
| "Hey Google, turn on the shop meter" | Meter relay ON (only if the meter has paid-up credit) |
| "Hey Google, activate Night Saver" / "Alexa, turn on Night Saver" | Runs the energy routine |
| "Alexa, ask Solar Grid what's my balance" | Speaks the credit balance and on/off state |
| "Alexa, ask Solar Grid how much energy I used today" | Speaks today's usage |

Meters appear as **smart plugs** (Google `OUTLET` / Alexa `SMARTPLUG`) with an on/off trait. Enabled routines appear
as **scenes**. Voice commands can never switch on a meter the contract considers inactive. The assistant says the
meter needs a top-up instead.

## Architecture

```
Google Home ──HTTPS (OAuth bearer)──▶ POST /api/smart-home/google/fulfillment ─┐
Alexa ──▶ AWS Lambda proxy (infra/smart-home/alexa/lambda) ──shared secret──▶  │
          POST /api/smart-home/alexa/directive | /alexa/custom ────────────────┤
                                                                               ▼
                                     lib/smartHomePlatforms.ts → lib/smartHome.ts
                                     ├─ on/off → MQTT solargrid/meters/<id>/control ({cmd, source})
                                     ├─ state  → contract get_meter (4 s timeout → reported offline)
                                     └─ routines, activity log, account links (SQLite)
```

## Account linking

This is standard OAuth 2.0 authorization-code linking, as both platforms require.

1. The assistant app opens `GET /api/smart-home/oauth/authorize`, which checks `client_id` and `redirect_uri` against
   the configured client and redirects to the web consent page `/smart-home/link`.
2. The owner connects their wallet and **signs a challenge transaction** (in the style of SEP-10: sequence 0, never
   submitted) to prove they control the address.
3. The owner chooses **which meters to share**, gives each a spoken nickname, and chooses whether the assistant may
   **control** them or only **read** their status.
4. The backend checks that the owner owns every selected meter on-chain, then issues a single-use authorization code
   valid for 10 minutes.
5. The platform exchanges the code at `/oauth/token` for an access token (1 hour) and a refresh token.

## Energy routines

Routines are managed at `/smart-home` in the web app or through the API. Each routine has one or more
`{ meterId, command: "on" | "off" }` actions and one trigger:

| Trigger | Example |
| --- | --- |
| `schedule` | `{ "type": "schedule", "time": "22:00", "days": [1,2,3,4,5], "timezone": "Africa/Lagos" }` |
| `balance_below` | `{ "type": "balance_below", "meterId": "M1", "threshold": 50000000 }`. Fires once each time the balance crosses the threshold, and re-arms after a top-up. |
| `voice` | Runs only when asked by voice or from the app |

Every enabled routine can also be run by voice as a scene.

## Privacy requirements

| Requirement | How it is met |
| --- | --- |
| Explicit consent | A wallet-signed consent screen lists exactly what is shared. Scopes are `read` or `read + control`. |
| Data minimisation | Platforms receive only meter nicknames/IDs, on/off state, and the balance when asked. There are no wallet addresses (`agentUserId` is a salted hash) and no usage history, except today's total when explicitly asked. |
| Least privilege | Only the selected meters are exposed. A read-only link cannot switch anything. Routines are only exposed when every meter they touch is part of the link. |
| Secure credentials | Access and refresh tokens are stored only as SHA-256 hashes. Auth codes are single use with a 10-minute expiry. Client secrets and the Lambda secret are compared in constant time. |
| Retention | Voice and routine activity is deleted after `SMART_HOME_ACTIVITY_RETENTION_DAYS` (default 30). Links unused for `SMART_HOME_LINK_INACTIVE_DAYS` (default 90) expire. |
| Transparency | Owners can see linked assistants, last use and the activity log at `/smart-home`. |
| Revocation and erasure | Unlink from the web app, Google `DISCONNECT`, or Alexa skill disable. **Delete my smart home data** (`DELETE /api/smart-home/data`) removes all links, routines and history. |

## Publishing checklist

Publishing needs the owner's developer accounts and certification review, so it can't be done from this repository.

**Alexa** (`infra/smart-home/alexa`)
1. Deploy `lambda/index.mjs` (Node 20) with `BACKEND_URL`, `PROXY_SECRET` and `ALEXA_SKILL_ID`. Add both the *Alexa
   Smart Home* and the *Alexa Skills Kit* triggers.
2. Create the skill with `ask deploy` from `skill-package/`, replacing `ACCOUNT_ID`, `REPLACE_ME` and the icon/privacy
   URLs. This is a multi-capability skill (smart home + custom).
3. Configure account linking from `accountLinking.json`. Set `SMART_HOME_ALEXA_CLIENT_ID`, `_CLIENT_SECRET`,
   `_REDIRECT_URIS` and `SMART_HOME_ALEXA_PROXY_SECRET` on the backend.
4. Test with the Alexa simulator and a real device, then submit for certification.

**Google Home** (`infra/smart-home/google/README.md`)
1. Create a cloud-to-cloud integration pointing at `/api/smart-home/google/fulfillment` and the OAuth endpoints.
2. Set `SMART_HOME_GOOGLE_CLIENT_ID`, `_CLIENT_SECRET` and `_REDIRECT_URIS`.
3. Pass the Smart Home Test Suite, then submit for certification.

## API

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/smart-home/auth/challenge` — `{ address }` | — |
| POST | `/api/smart-home/auth/session` — `{ address, transaction }` (signed XDR) | — |
| GET | `/api/smart-home/oauth/authorize` | — |
| POST | `/api/smart-home/oauth/consent` | session |
| POST | `/api/smart-home/oauth/token` | OAuth client |
| POST | `/api/smart-home/google/fulfillment` | OAuth bearer |
| POST | `/api/smart-home/alexa/directive` · `/alexa/custom` | Lambda proxy secret |
| GET / DELETE | `/api/smart-home/links` · `/links/:id` | session |
| GET / POST / PATCH / DELETE | `/api/smart-home/routines` · `/routines/:id` | session |
| POST | `/api/smart-home/routines/:id/run` | session |
| GET | `/api/smart-home/activity` | session |
| DELETE | `/api/smart-home/data` | session |

The session is `Authorization: Bearer <token>` from `/auth/session`, and is valid for 1 hour.
