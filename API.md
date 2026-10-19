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
