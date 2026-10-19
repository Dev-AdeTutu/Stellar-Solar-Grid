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
