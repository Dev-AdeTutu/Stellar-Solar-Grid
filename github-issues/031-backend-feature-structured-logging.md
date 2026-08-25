---
name: Feature Request
about: Propose a new feature or improvement
title: "[Feature] Implement structured JSON logging"
labels: enhancement
assignees: ''
---

## Problem Statement

Current logging uses Winston with text format, making it difficult to parse logs in monitoring systems (ELK, Datadog, CloudWatch). Structured logging would enable better filtering, searching, and alerting.

## Proposed Solution

Switch to JSON-formatted logs with consistent fields:

```json
{
  "timestamp": "2025-08-25T10:30:00.123Z",
  "level": "info",
  "service": "solargrid-backend",
  "component": "iot-bridge",
  "message": "Usage update processed",
  "meter_id": "METER001",
  "units": 150,
  "request_id": "abc-123",
  "duration_ms": 45
}
```

Standard fields for every log:
- timestamp, level, service, component, message
- request_id (from context middleware)
- error stack traces in `error` field (not stringified)

Keep human-readable format for development (`NODE_ENV=development`).

## Alternatives Considered

- Keep text logs: Harder to parse and query
- Custom log format: Doesn't work with standard tools

## Affected Component(s)

- [ ] Frontend (React / TypeScript)
- [x] Backend / IoT bridge (Node.js)
- [ ] Smart contracts (Soroban / Rust)
- [x] Documentation
- [ ] Other

## Additional Context

Winston already supports JSON format via `winston.format.json()`. Minimal code change required.
