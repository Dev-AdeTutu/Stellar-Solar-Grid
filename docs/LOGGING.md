# Structured Logging

Closes #680.

The backend logs via Winston. In production (`NODE_ENV=production`, or
`LOG_FORMAT=json`) every line is a single JSON object with a consistent
shape, ready for ingestion by ELK, Datadog, CloudWatch, etc.:

```json
{
  "timestamp": "2025-08-25T10:30:00.123Z",
  "level": "info",
  "service": "solargrid-backend",
  "message": "Usage update processed",
  "meter_id": "METER001",
  "units": 150,
  "request_id": "3f8b6e2a-...",
  "duration_ms": 45
}
```

Standard fields on every line:

- `timestamp`, `level`, `service`, `message` — always present.
- `request_id` — added automatically for any log emitted while handling an
  HTTP request (see `backend/src/lib/requestContext.ts`); the same id is
  returned to the client via the `X-Request-Id` response header for
  cross-referencing.
- `component` — opt-in; use `getComponentLogger("iot-bridge")` from
  `backend/src/lib/logger.ts` to get a child logger that tags every line.
- Errors passed to the logger keep their stack trace under an `error` field
  instead of being stringified away (`winston.format.errors({ stack: true })`).

## Development

Outside production, logs default to a colorized, human-readable single-line
format instead of JSON. Set `LOG_FORMAT=json` to force structured output
locally (e.g. to test log parsing), or `LOG_FORMAT=text` to force the
human-readable format in production.
