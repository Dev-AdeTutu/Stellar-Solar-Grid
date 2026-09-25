# Frontend features

## Geographic meter map

Open `/dashboard/provider/map` to view meters with valid WGS84 coordinates. The page requests `GET /api/meters/map`, renders active meters in green and inactive meters in slate, scales marker size by usage, and supports region, status, and provider filters. Add coordinates through the existing meter metadata endpoint:

```json
{
  "metadata": {
    "latitude": 6.5244,
    "longitude": 3.3792,
    "region": "Lagos",
    "provider": "Provider A",
    "usage": 1200,
    "active": true
  }
}
```

Invalid or missing coordinates are omitted from the map rather than projected inaccurately.

## Auto top-up

Render `AutoTopupSettings` for an authenticated meter owner. The owner must approve the contract allowance before enabling the feature. The component calls `enable_auto_topup` or `disable_auto_topup`; the backend/oracle triggers `trigger_auto_topup` when the balance crosses the threshold.
