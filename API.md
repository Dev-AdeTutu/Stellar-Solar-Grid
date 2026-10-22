# Stellar Solar Grid API Reference

## Blockchain Transaction History Explorer (#1004)

### `GET /api/transactions/:address`

Returns indexed on-chain contract transactions for a user address, categorized into `payments`, `registrations`, `transfers`, and `admin_actions`. Each entry includes a direct `explorerUrl` link to the Stellar block explorer.

#### Query Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `type` | `string` | Optional category filter (`payments`, `registrations`, `transfers`, `admin_actions`). |
| `meter_id` | `string` | Optional smart meter ID filter (e.g., `meter-101`). |
| `start_date` | `string` | Optional ISO-8601 start timestamp filter. |
| `end_date` | `string` | Optional ISO-8601 end timestamp filter. |
| `format` | `string` | Set to `csv` to export transactions as a downloadable CSV file for accounting. |

### `POST /api/transactions`

Indexes a new on-chain contract transaction event for a user address.

## Meter Network Topology (#1006)

### `GET /api/network/topology`

Returns the hierarchical network topology graph (`grid -> transformer -> meter`) including node statuses (`active`, `inactive`, `fault`) and link load percentages.

## White-Label Provider Customization (#1005)

### `POST /api/providers/:id/branding`

Uploads or updates a provider's branding theme (logo, primary/secondary/accent colors, custom domain, email templates, and mobile app bundle ID).

## Automated Billing Cycle Management (#971)

### `GET /api/meters/:id/billing-history`

Returns the billing cycle state, history of invoices, and next billing date for a meter.

## Carbon Footprint Calculator (#972)

### `GET /api/meters/:id/carbon-footprint`

Calculates emissions saved (in kg CO2), equivalent trees planted, vehicle miles offset, and returns shareable badge data for a given meter based on regional emission factors.

## Dynamic Pricing Engine (#973)

### `POST /api/pricing/multiplier`

Updates the dynamic electricity pricing multiplier (admin endpoint) and emits a real-time `PriceUpdated` event.

### `GET /api/pricing/current`

Retrieves the current dynamic pricing rate, multiplier, and next update schedule.

## Meter Performance Benchmarking (#974)

### `GET /api/meters/:id/benchmark`

Returns benchmarking statistics, efficiency percentiles, peer group averages, and actionable insights for a meter compared to other meters in the same capacity and location tier.


## Customer Support Ticketing (#968)

Support tickets require a wallet session obtained from `POST /api/smart-home/auth/session`. Send the returned token as `Authorization: Bearer <token>`; ticket ownership is derived from the authenticated wallet address and cannot be supplied by the client.

### `POST /api/tickets`

Creates a ticket for the authenticated user.

```json
{
  "subject": "Meter is offline",
  "description": "The meter has not reported for two hours.",
  "priority": "high",
  "email": "user@example.com"
}
```

`subject` is required (1–160 characters), `description` is required (1–10,000 characters), `priority` is optional (`low`, `normal`, `high`, or `urgent`) and defaults to `normal`, and `email` is optional but must be a valid address when present. Returns `201` with `{ "ticket": ... }`; new tickets start with `status: "open"`.

### `GET /api/tickets`

Lists the authenticated user's tickets, newest first. Returns `{ "tickets": [...] }`. Tickets belonging to other wallet addresses are never included.

### `PATCH /api/tickets/:id`

Updates the status of a ticket owned by the authenticated user.

```json
{ "status": "in_progress" }
```

Allowed statuses are `open`, `in_progress`, `resolved`, and `closed`. Returns `404` for an unknown ticket or a ticket owned by another user, and `400` for an invalid id or status.

Ticket objects contain `id`, `user`, `userEmail`, `subject`, `description`, `status`, `priority`, `createdAt`, and `updatedAt`. When `SUPPORT_EMAIL` is configured, ticket creation and status changes notify the support team; users who provide `email` receive the same updates. Notifications use the existing `EMAIL_PROVIDER`/`EMAIL_FROM` mailer configuration and never prevent a successfully persisted ticket.
