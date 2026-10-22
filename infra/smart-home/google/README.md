# Google Home — SolarGrid Smart Home Action (#904)

Google Smart Home Actions are configured in the [Google Home Developer Console](https://console.home.google.com/)
rather than shipped as code. Use these values:

| Setting | Value |
| --- | --- |
| Integration type | Cloud-to-cloud |
| Fulfillment URL | `https://<api-host>/api/smart-home/google/fulfillment` |
| OAuth client ID / secret | `SMART_HOME_GOOGLE_CLIENT_ID` / `SMART_HOME_GOOGLE_CLIENT_SECRET` |
| Authorization URL | `https://<api-host>/api/smart-home/oauth/authorize` |
| Token URL | `https://<api-host>/api/smart-home/oauth/token` |
| Scopes | `read control` |
| Device types | `OUTLET` (meters), `SCENE` (energy routines) |

Set `SMART_HOME_GOOGLE_REDIRECT_URIS=https://oauth-redirect.googleusercontent.com/r/<project-id>` on the backend
(include `https://oauth-redirect-sandbox.googleusercontent.com/r/<project-id>` while testing).

Run the [Smart Home Test Suite](https://developers.home.google.com/tools/smart-home-test-suite) against a linked test
account before submitting for certification. See `docs/SMART_HOME.md` for the full checklist.

## Voice Assistant Flows (#989)

In addition to the smart home device traits above, the SolarGrid Google Assistant action exposes
conversational voice intents for meter management. These are served by the same fulfillment webhook:

| Setting | Value |
| --- | --- |
| Fulfillment webhook URL | `https://<api-host>/api/smart-home/google/fulfillment` |
| OAuth client ID / secret | `SMART_HOME_GOOGLE_CLIENT_ID` / `SMART_HOME_GOOGLE_CLIENT_SECRET` |
| Authorization URL | `https://<api-host>/api/smart-home/oauth/authorize` |
| Token URL | `https://<api-host>/api/smart-home/oauth/token` |
| Scopes | `read control` |

> **Important:** the Google Assistant action must be configured with the **same OAuth client**
> (`SMART_HOME_GOOGLE_CLIENT_ID` / `SMART_HOME_GOOGLE_CLIENT_SECRET`) as the smart home action so
> that account linking and the fulfillment webhook share a single authenticated session.

### Voice intents

| Intent | Purpose | Example utterances |
| --- | --- | --- |
| `check balance` | Report the current account/meter balance | "Hey Google, ask SolarGrid what's my balance" / "…check my meter balance" |
| `check usage` | Report energy usage for a period | "Hey Google, ask SolarGrid how much energy did I use this week" / "…what's my usage today" |
| `check status` | Report meter connection/health status | "Hey Google, ask SolarGrid if my meter is online" / "…what's the status of my meter" |
| `make payment` | Start a payment flow (returns a confirmation token) | "Hey Google, ask SolarGrid to pay my bill" / "…make a payment of 50" |
| `confirm payment` | Complete a previously started payment | "Hey Google, ask SolarGrid to confirm my payment" / "…yes, confirm the payment" |

### Secure payment confirmation flow

Voice payments require two steps and are never completed on the strength of a single utterance:

1. **`make payment`** — the user states an amount (and optional meter). The backend validates the
   request and returns a short-lived **confirmation token**; no funds move at this point.
2. **`confirm payment`** — the user must supply the confirmation token **and** complete a
   **2FA/PIN** challenge. Only when both the token and the second factor validate does the backend
   execute the payment.

Confirmation tokens are single-use and expire quickly; expired or reused tokens are rejected and
the user is asked to start the payment again.

### Supported locales

The action ships with multi-language support for the following locales:

- `en-US` (English — United States)
- `en-GB` (English — United Kingdom)
- `es-ES` (Spanish — Spain)
- `fr-FR` (French — France)
- `de-DE` (German — Germany)

See `docs/VOICE_ASSISTANT.md` for the full intent reference, authentication details, and the
end-to-end payment confirmation flow.