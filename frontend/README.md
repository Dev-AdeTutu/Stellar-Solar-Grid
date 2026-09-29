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

## Error boundary (#839)

`src/components/ErrorBoundary.tsx` wraps the app in `src/app/layout.tsx` (and the dashboard pages). When a render error occurs it:

- shows a friendly fallback UI with collapsible error details;
- logs the error to the backend monitoring endpoint `POST /api/client-errors` (message, stack, component stack, URL, user agent);
- offers **Try Again** to reset the boundary and re-render;
- offers **Report Issue**, opening a prefilled GitHub issue with the error details.

Tests: `src/__tests__/ErrorBoundary.test.tsx`.
