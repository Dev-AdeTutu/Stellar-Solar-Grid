---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] Low-balance webhook has no signature verification"
labels: bug, security
assignees: ''
---

## Describe the Bug

The low-balance webhook sends POST requests to provider endpoints without any signature or authentication. Recipients cannot verify the request actually came from SolarGrid backend, enabling spoofing attacks.

## Steps to Reproduce

1. Register webhook URL: `https://attacker.com/fake-webhook`
2. Attacker sends fake low-balance notification to provider
3. Provider cannot distinguish real from fake notifications

## Expected Behavior

Webhook requests should include HMAC signature in header:
```
X-Signature-256: sha256=abc123...
```

Generated using shared secret:
```typescript
const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(JSON.stringify(payload))
  .digest('hex');
```

Provider validates signature before processing webhook.

## Actual Behavior

No signature sent. Providers must trust all incoming requests or implement IP allowlisting (brittle).

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 |
| Node.js version | 20.14.2 |
| Network | testnet |

## Additional Context

Follow Stripe/GitHub webhook signature pattern. Add `WEBHOOK_SECRET` env var and document verification steps.
