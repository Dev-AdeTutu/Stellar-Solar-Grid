---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Add request/response logging middleware"
labels: enhancement
assignees: ''
---

## Problem Statement

Debugging production issues is difficult without visibility into API requests and responses. Currently, only errors are logged, making it hard to trace request flows and identify patterns.

## Proposed Solution

Add Express middleware that logs all requests and responses:

**Request log:**
```json
{
  "type": "request",
  "method": "POST",
  "path": "/api/payments",
  "request_id": "abc-123",
  "ip": "192.168.1.100",
  "user_agent": "Mozilla/5.0...",
  "body": { "meterId": "METER1" }
}
```

**Response log:**
```json
{
  "type": "response",
  "request_id": "abc-123",
  "status": 200,
  "duration_ms": 234,
  "body_size": 156
}
```

Features:
- Generate unique `request_id` per request
- Redact sensitive fields (payment secrets, API keys)
- Sample 10% of successful requests (log all errors)
- Configurable via `LOG_REQUESTS=true|false`

## Alternatives Considered

- Third-party APM (Datadog, New Relic): Higher cost
- No request logging: Poor observability

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Use `express-winston` or `morgan` with custom token formatters.
