# SolarGrid Compliance Reporting

SolarGrid can generate signed reports for **GSE, I-REC, EU-RED, and FERC** frameworks.

## Endpoint

```text
GET /api/reports/compliance?format=pdf&framework=GSE&period=monthly
```

- `format`: `json`, `csv`, or `pdf`
- `framework`: `GSE`, `I-REC`, `EU-RED`, or `FERC`
- `period`: `monthly` or `quarterly`

The report includes customer count, distributed energy in MWh, revenue in XLM, subsidies in XLM, the covered period, generation timestamp, and a SHA-256 signature. The JSON payload is the canonical source for verifying the signature; configure `COMPLIANCE_SIGNING_SECRET` before production use.

## Automation

`GET /api/reports/compliance/schedules` returns the configured monthly and quarterly schedule metadata. Deployments should invoke the report generator from their scheduler on the first day of the relevant period, archive the signed artifact, and retain the framework and period alongside it.

## Data quality

Reports query the current Soroban meter registry and provider revenue. If the RPC is temporarily unavailable, the service returns a structurally valid report with zero unavailable aggregates only when the query cannot be completed; operators should treat that result as a data-quality warning and rerun before submission.

## Sandbox mode

Regulatory-sensitive features can be exercised in an isolated **sandbox** environment before they are promoted to production. See [SANDBOX.md](./SANDBOX.md) for the full guide.

### Isolation from production compliance

Sandbox reports are fully isolated from production compliance:

- Sandbox runs use a separate signing secret (`SANDBOX_COMPLIANCE_SIGNING_SECRET`) so sandbox artifacts can never be mistaken for, or verified against, production signatures.
- Sandbox reports are generated from **synthetic test data** only; they never query the production Soroban meter registry or provider revenue.
- Sandbox artifacts are tagged with `environment: sandbox` in the JSON payload and are written to a separate archive namespace, keeping them out of production retention and submission pipelines.
- Experimental features are gated behind feature flags that default to **off** in production, so enabling them in the sandbox has no effect on production compliance behavior.

### Promoting features safely

1. Enable the relevant feature flag in the sandbox and validate behavior against synthetic data.
2. Review generated sandbox reports and confirm signatures verify with the sandbox secret.
3. Run the sandbox isolation tests to confirm no production data or secrets are touched.
4. Promote by enabling the feature flag in production only after sandbox validation passes; production continues to use the production signing secret and live data sources.