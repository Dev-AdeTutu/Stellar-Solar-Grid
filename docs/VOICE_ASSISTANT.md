# Voice Assistant Integration

## Overview

The Voice Assistant Integration allows users to manage their prepaid utility meters using
Amazon Alexa and Google Assistant. Users can check their balance, review recent usage, and
make payments entirely by voice, with a secure confirmation flow that protects wallet funds.

Supported assistants:

- **Amazon Alexa** — custom skill backed by the voice API endpoints.
- **Google Assistant** — conversational action backed by the same voice API endpoints.

Both assistants share a single backend implementation, so intents, locales, and security
guarantees are identical across platforms.

## Architecture

```
┌──────────────┐        ┌──────────────┐
│    Alexa     │        │   Google     │
│    Skill     │        │  Assistant   │
└──────┬───────┘        └──────┬───────┘
       │  HTTPS (OAuth 2.0)    │
       └───────────┬───────────┘
                   ▼
        ┌──────────────────────────┐
        │   Backend Voice API      │
        │  /api/voice/parse        │
        │  /api/voice/payment/...  │
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐
        │   voiceAssistant.ts      │
        │  (intent parsing, NLU,   │
        │   locale handling)       │
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐
        │  smartHomePlatforms.ts   │
        │  (meter/account lookup,  │
        │   balance & usage)       │
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐
        │   Payments / Wallet      │
        │  (signed, 2FA-gated)     │
        └──────────────────────────┘
```

Flow summary:

1. Alexa or Google Assistant sends the user's utterance to the backend voice API over HTTPS.
2. `voiceAssistant.ts` parses the utterance into a structured intent and extracts slots
   (meter ID, amount, locale).
3. Read-only intents (balance, usage) are resolved through `smartHomePlatforms.ts`.
4. Payment intents return a confirmation prompt and a short-lived, single-use confirmation
   token. The payment is only executed after the user explicitly confirms and passes 2FA/PIN.

## Supported Intents

| Intent | Description | Example utterances (en-US) |
| --- | --- | --- |
| `CheckBalance` | Report the current meter balance. | "What's my meter balance?", "How much credit do I have left?" |
| `CheckUsage` | Report recent consumption. | "How much power did I use today?", "Show my usage this week." |
| `MakePayment` | Start a payment flow. | "Pay twenty dollars on my meter.", "Top up my meter by ten dollars." |
| `ConfirmPayment` | Confirm a pending payment. | "Yes, confirm the payment.", "Go ahead and pay." |
| `CancelPayment` | Cancel a pending payment. | "No, cancel that.", "Don't pay." |
| `LinkAccount` | Begin account linking. | "Link my meter account." |
| `Help` | Provide usage help. | "What can you do?", "Help." |

### Example utterances per locale

**en-US**

- "What's my meter balance?"
- "How much power did I use today?"
- "Pay twenty dollars on my meter."

**en-GB**

- "What's my meter balance?"
- "How much electricity have I used this week?"
- "Top up my meter by ten pounds."

**es-ES**

- "¿Cuál es el saldo de mi medidor?"
- "¿Cuánta energía he usado hoy?"
- "Paga veinte euros en mi medidor."

**fr-FR**

- "Quel est le solde de mon compteur ?"
- "Combien d'énergie ai-je utilisé aujourd'hui ?"
- "Payez vingt euros sur mon compteur."

## Voice API Endpoints

All endpoints require an OAuth 2.0 bearer token obtained through wallet-signed account
linking (see Security Model). Requests and responses are JSON.

### `POST /api/voice/parse`

Parses an utterance into an intent and resolves read-only intents.

Request:

```json
{
  "utterance": "What's my meter balance?",
  "locale": "en-US",
  "sessionId": "abc-123"
}
```

Response (read-only intent):

```json
{
  "intent": "CheckBalance",
  "slots": {},
  "speech": "Your meter balance is 42 dollars and 50 cents.",
  "locale": "en-US"
}
```

Response (payment intent requiring confirmation):

```json
{
  "intent": "MakePayment",
  "slots": { "amount": 20.00, "currency": "USD" },
  "speech": "You want to pay 20 dollars. Say yes to confirm.",
  "confirmationToken": "ct_9f8e7d6c5b4a",
  "expiresIn": 120
}
```

### `POST /api/voice/payment/confirm`

Confirms and executes a pending payment. Requires the confirmation token and a valid 2FA/PIN.

Request:

```json
{
  "confirmationToken": "ct_9f8e7d6c5b4a",
  "pin": "1234",
  "sessionId": "abc-123"
}
```

Response:

```json
{
  "status": "completed",
  "speech": "Your payment of 20 dollars was successful. Your new balance is 62 dollars and 50 cents.",
  "transactionId": "tx_0011223344"
}
```

### `POST /api/voice/payment/cancel`

Cancels a pending payment and invalidates its confirmation token.

Request:

```json
{
  "confirmationToken": "ct_9f8e7d6c5b4a",
  "sessionId": "abc-123"
}
```

Response:

```json
{
  "status": "cancelled",
  "speech": "Okay, I've cancelled that payment."
}
```

## Security Model

- **Wallet-signed account linking.** Users link their meter account by signing a challenge
  with their wallet. The signature is verified server-side before an OAuth token is issued.
- **Explicit payment confirmation token.** Payment intents never execute immediately. The
  backend issues a short-lived confirmation token that must be echoed back on confirm.
- **Mandatory 2FA/PIN for payments.** Every payment requires a valid 2FA code or PIN in
  addition to the confirmation token. Read-only intents do not require 2FA.
- **Single-use, short-lived tokens.** Confirmation tokens expire after 120 seconds and are
  invalidated on first use, on cancellation, or on expiry.
- **No wallet addresses spoken aloud.** Wallet addresses and other sensitive identifiers are
  never included in spoken responses; only masked references are used.
- **Activity logging and retention.** All voice interactions are logged with intent, locale,
  outcome, and timestamp. Logs are retained per the platform retention policy and never
  contain PINs, 2FA codes, or full wallet addresses.

## Multi-Language Support

Locales are resolved from the assistant request and fall back to `en-US` when unsupported.
Each locale provides intent utterances and response templates.

To add a new locale:

1. Add the locale code (e.g. `de-DE`) to the supported locales list in `voiceAssistant.ts`.
2. Provide intent utterances for the locale in the assistant interaction model
   (Alexa interaction model / Google action).
3. Add response templates for the locale in the voice response catalog.
4. Add example utterances to the table above.
5. Add tests covering the new locale's intents and responses.

## Setup Instructions

### Alexa Skill

1. Create a custom skill in the Alexa Developer Console.
2. Configure account linking with the OAuth 2.0 endpoints used by the voice API.
3. Import the interaction model containing the intents listed above.
4. Set the skill endpoint to the backend voice API base URL.
5. Enable the skill and link your account via the Alexa app.

### Google Assistant Action

1. Create a project in the Actions on Google console.
2. Configure account linking with the same OAuth 2.0 endpoints.
3. Define the intents and training phrases matching the supported intents.
4. Set the fulfillment URL to the backend voice API base URL.
5. Test and publish the action.

For smart-home device discovery and control setup shared with these assistants, see
[`docs/SMART_HOME.md`](./SMART_HOME.md).