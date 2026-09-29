# Automated Monthly Billing (#902)

On the **1st of every month (UTC)** the backend generates a bill for the previous calendar month for every meter that
has a billing account or recorded usage. Each bill is:

1. calculated from the meter's recorded usage;
2. rendered to a PDF and stored under `data/bills/`;
3. emailed, with the PDF attached and a payment link, to the address on the meter's billing account;
4. kept permanently, so the full history is available at `/bills` in the web app and through the API.

The scheduler checks hourly. Generation is idempotent because `(meter_id, period)` is unique, so a restart or repeated
check on the 1st never duplicates a bill. To (re)run a period manually, call `POST /api/billing/run` with
`{ "period": "YYYY-MM" }`.

## Charge calculation

All amounts are integer **stroops** (1 XLM = 10,000,000 stroops).

| Line | Formula |
| --- | --- |
| Energy | Σ usage cost recorded for the period, or `units × BILLING_UNIT_PRICE_STROOPS` when that variable is set |
| Service | `BILLING_SERVICE_CHARGE_STROOPS` (fixed monthly charge) |
| Tax | `round((energy + service) × BILLING_TAX_RATE)` |
| **Total** | energy + service + tax |

Usage comes from `usage_events` combined with the `usage_summary` daily roll-ups. Compaction deletes the detail rows it
summarises, so the two sources never double count.

## Payment

Each bill carries a `payment_link` to the web pay page, pre-filled with the meter, amount and bill reference
(`/pay?meter=…&amount=…&bill=…`). If `BILLING_PAYMENT_DESTINATION` is set, the email also includes a SEP-0007
`web+stellar:pay` link for wallets. Record a payment with `POST /api/billing/bills/:id/paid` (`{ txHash }`). This also
regenerates the PDF with status **PAID**.

## Email

`EMAIL_PROVIDER` selects `resend`, `sendgrid`, or `log`. The default, `log`, writes the message to the log without
sending it. Delivery failures are stored on the bill (`email_error`) and can be retried with
`POST /api/billing/bills/:id/resend`. Meters without a billing email still get bills; they just aren't emailed.

## API

| Method | Path | Auth |
| --- | --- | --- |
| PUT | `/api/billing/accounts/:meterId` — `{ email, name?, stellarAddress? }` | admin |
| GET | `/api/billing/accounts/:meterId` | admin |
| POST | `/api/billing/run` — `{ period? }` (defaults to last month) | admin |
| GET | `/api/billing/meters/:meterId/bills?limit=24` | — |
| GET | `/api/billing/bills/:billId` | — |
| GET | `/api/billing/bills/:billId/pdf` | — |
| POST | `/api/billing/bills/:billId/resend` | admin |
| POST | `/api/billing/bills/:billId/paid` — `{ txHash? }` | admin |

See `backend/.env.example` for all `BILLING_*` / `EMAIL_*` settings.
