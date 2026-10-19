---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add webhook notifications for successful payments"
labels: enhancement
assignees: ''
---

## Problem Statement

Energy providers need real-time notifications when customers make payments to trigger business processes (send SMS receipt, update CRM, activate rewards). Currently, they must poll the API or monitor blockchain events manually.

## Proposed Solution

Add payment webhook similar to existing low-balance webhook:

**Configuration:**
```bash
PAYMENT_WEBHOOK_URL=https://provider.com/webhooks/payment-received
```

**Webhook payload:**
```json
{
  "event": "payment_received",
  "meter_id": "METER123",
  "payer": "GUSER...",
  "amount": 5000000,
  "plan": "Daily",
  "tx_hash": "abc123...",
  "timestamp": "2025-08-25T10:30:00Z",
  "new_balance": 12500000
}
```

Features:
- POST to configured URL after successful payment
- Include HMAC signature for verification
- Retry with exponential backoff (reuse existing retry logic)
- Log webhook delivery status

## Alternatives Considered

- Real-time WebSocket stream: More complex infrastructure
- Event polling: Higher latency, more API calls

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Should support multiple webhook URLs (payment, low-balance, meter-registered) via config array.
