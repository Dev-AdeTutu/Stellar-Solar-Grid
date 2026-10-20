# Compliance Automation

Rules are defined as code in `backend/src/lib/compliance.ts` (`DEFAULT_RULES`). Each rule has an `id`, `description`, `severity` and a `check(op)` function returning a violation message or `null`.

- **Continuous monitoring:** `complianceMonitor` middleware evaluates every non-GET API request.
- **Alerting:** violations are logged via `logger.warn`; register extra handlers with `complianceEngine.onViolation(fn)`.
- **Audit trail:** every check (pass or fail) is recorded.

| Endpoint | Description |
|---|---|
| `GET /api/compliance/rules` | List rules |
| `POST /api/compliance/check` | Evaluate an operation `{type, meterId, amount, actor}` |
| `GET /api/compliance/audit?since=` | Audit trail |
| `GET /api/compliance/report?since=` | Generated compliance report |

Add a rule: `complianceEngine.addRule({ id, description, severity, check })`.
