# Energy Price Heatmap - Issue #922

Interactive energy price heatmap showing real-time prices across different grid zones with historical playback.

## Overview

The price heatmap provides real-time visualization of energy prices across 100+ grid zones. Users can see current prices, explore historical data, and understand price patterns across geographic regions.

## Architecture

### Backend Components

#### 1. Price Heatmap Service (`backend/src/lib/priceHeatmap.ts`)
- Grid zone management (geographic regions with pricing data)
- Real-time price data with EventEmitter for subscriptions
- Historical price snapshots for playback
- Optimized data structures for 1000+ zones
- SQLite database with WAL mode for performance

#### 2. API Routes (`backend/src/routes/priceHeatmap.ts`)
- RESTful endpoints for zones, prices, and historical data
- Optimized heatmap rendering endpoint
- Statistics and analytics endpoints
- Region-based and bounding-box filtering

#### 3. Database Schema

**`grid_zones` table:**
```sql
- id: TEXT PRIMARY KEY (e.g., "zone_0_0")
- name: TEXT (e.g., "Zone 0-0")
- region: TEXT (e.g., "Region 0-0")
- latitude: REAL (decimal degrees)
- longitude: REAL (decimal degrees)
- radius: REAL (meters, default 5000)
- population: INTEGER (estimated population served)
- base_price: REAL (base price in $/kWh)
- geometry: TEXT (optional GeoJSON)
- metadata: TEXT (optional additional data)
- created_at: INTEGER (Unix timestamp)
```

**`zone_prices` table:**
```sql
- id: INTEGER PRIMARY KEY AUTOINCREMENT
- zone_id: TEXT FOREIGN KEY -> grid_zones(id)
- price: REAL (current price in $/kWh)
- timestamp: INTEGER (Unix timestamp)
- demand: REAL (kW demand)
- supply: REAL (kW supply available)
- congestion: REAL (0-1, congestion factor)
```

**`price_snapshots` table:**
```sql
- id: INTEGER PRIMARY KEY AUTOINCREMENT
- timestamp: INTEGER (Unix timestamp)
- snapshot_data: TEXT (JSON: { zoneId: price })
- zones_count: INTEGER (number of zones in snapshot)
```

**Indexes for performance:**
- `idx_zone_prices_zone` on zone_prices(zone_id)
- `idx_zone_prices_timestamp` on zone_prices(timestamp)
- `idx_zone_prices_zone_time` on zone_prices(zone_id, timestamp)
- `idx_snapshots_timestamp` on price_snapshots(timestamp)

### Frontend Component

#### React Heatmap Component (`frontend/src/components/PriceHeatmap.tsx`)
- Interactive Leaflet map with OpenStreetMap tiles
- Real-time price visualization with color gradients
- Historical playback with timeline controls
- Mobile-responsive design
- Optimized rendering for 100+ zones

#### Color Gradient System
Prices are visualized using a three-stage color gradient:
- **Green** (0-33%): Low prices
- **Yellow** (33-67%): Medium prices  
- **Red** (67-100%): High prices

Formula: `normalized = (price - minPrice) / (maxPrice - minPrice)`

## API Endpoints

### GET `/api/heatmap/zones`
Get all grid zones (optionally filtered by region or bounding box)

**Query Parameters:**
- `region` (optional): Filter by region name
- `minLat`, `maxLat`, `minLon`, `maxLon` (optional): Bounding box filter

**Response:**
```json
{
  "success": true,
  "zones": [
    {
      "id": "zone_0_0",
      "name": "Zone 0-0",
      "region": "Region 0-0",
      "latitude": 37.7749,
      "longitude": -122.4194,
      "radius": 5000,
      "population": 35420,
      "basePrice": 0.15
    }
  ],
  "count": 100
}
```

### GET `/api/heatmap/zones/:zoneId`
Get detailed information for a specific zone

**Response:**
```json
{
  "success": true,
  "zone": {
    "id": "zone_0_0",
    "name": "Zone 0-0",
    "region": "Region 0-0",
    "latitude": 37.7749,
    "longitude": -122.4194,
    "radius": 5000,
    "population": 35420,
    "basePrice": 0.15,
    "currentPrice": 0.17,
    "demand": 850.5,
    "supply": 920.3,
    "congestion": 0.08,
    "stats": {
      "minPrice": 0.12,
      "maxPrice": 0.22,
      "avgPrice": 0.16,
      "currentPrice": 0.17
    }
  }
}
```

### GET `/api/heatmap/current`
Get optimized heatmap data for rendering (all zones, minimal data)

**Response:**
```json
{
  "success": true,
  "zones": [
    {
      "id": "zone_0_0",
      "lat": 37.7749,
      "lon": -122.4194,
      "price": 0.17,
      "name": "Zone 0-0",
      "region": "Region 0-0"
    }
  ],
  "priceRange": {
    "min": 0.12,
    "max": 0.22
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### GET `/api/heatmap/prices`
Get detailed current prices for all zones

**Response:**
```json
{
  "success": true,
  "prices": [
    {
      "zoneId": "zone_0_0",
      "price": 0.17,
      "demand": 850.5,
      "supply": 920.3,
      "congestion": 0.08,
      "timestamp": "2024-01-15T10:30:00Z"
    }
  ],
  "count": 100,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### GET `/api/heatmap/historical`
Get historical price snapshots

**Query Parameters:**
- `startTime` (optional): ISO 8601 timestamp
- `endTime` (optional): ISO 8601 timestamp
- `zoneIds` (optional): Comma-separated zone IDs

**Response:**
```json
{
  "success": true,
  "snapshots": [
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "prices": {
        "zone_0_0": 0.16,
        "zone_0_1": 0.15,
        ...
      }
    }
  ],
  "count": 288
}
```

### GET `/api/heatmap/zones/:zoneId/stats`
Get price statistics for a zone

**Query Parameters:**
- `startTime` (optional): Start time for stats
- `endTime` (optional): End time for stats

**Response:**
```json
{
  "success": true,
  "zoneId": "zone_0_0",
  "stats": {
    "minPrice": "0.1200",
    "maxPrice": "0.2200",
    "avgPrice": "0.1600",
    "currentPrice": "0.1700",
    "priceRange": "0.1000",
    "volatility": "62.50%"
  }
}
```

### GET `/api/heatmap/regions`
Get all regions with aggregate statistics

**Response:**
```json
{
  "success": true,
  "regions": [
    {
      "name": "Region 0-0",
      "zonesCount": 9,
      "avgPrice": "0.1650",
      "totalPopulation": 285340
    }
  ],
  "count": 9
}
```

### GET `/api/heatmap/summary`
Get overall heatmap summary statistics

**Response:**
```json
{
  "success": true,
  "summary": {
    "totalZones": 100,
    "priceStats": {
      "min": "0.1200",
      "max": "0.2200",
      "avg": "0.1600",
      "range": "0.1000"
    },
    "distribution": [
      {
        "label": "Low",
        "count": 32,
        "percentage": "32.0%"
      },
      {
        "label": "Normal",
        "count": 45,
        "percentage": "45.0%"
      },
      {
        "label": "High",
        "count": 23,
        "percentage": "23.0%"
      }
    ],
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

## Features

### ✅ Real-Time Price Visualization
- Updates every 5 seconds (configurable)
- Color-coded zones based on price
- Smooth transitions between price updates
- Live status indicator

### ✅ Interactive Map
- Zoom and pan controls
- Click zones for detailed information
- Popup with zone details and current stats
- OpenStreetMap base layer
- Responsive to screen size

### ✅ Historical Playback
- View price changes over last 24 hours
- Play/pause controls
- Timeline scrubbing
- Speed controls
- Snapshot every 5 seconds

### ✅ Color Gradient System
- Green → Yellow → Red gradient
- Based on normalized price range
- Clear visual distinction
- Accessible color contrast

### ✅ Performance Optimization
- Efficient SQLite indexes
- In-memory price cache
- Optimized API endpoints
- Periodic snapshots (not every update)
- CircleMarker rendering (not full polygons)

### ✅ Geographic Features
- 100 sample zones in 10x10 grid
- ~5km radius per zone
- Region grouping
- Bounding box queries
- Simulated SF Bay Area layout

## Configuration

### Environment Variables

```bash
# Database path
PRICE_HEATMAP_DB_PATH=./data/price_heatmap.sqlite

# Real-time simulation (default: 5000ms = 5 seconds)
PRICE_UPDATE_INTERVAL=5000
```

### Frontend Props

```typescript
<PriceHeatmap
  autoUpdate={true}        // Enable auto-refresh
  updateInterval={5000}    // Update interval in ms
/>
```

## Price Simulation

The system includes a real-time price simulator that:

1. **Updates prices every 5 seconds** (default)
2. **Simulates realistic variations:**
   - Peak hour multiplier (16:00-20:00): 1.2x
   - Random fluctuations: ±5%
   - Congestion-based adjustments
   - Supply/demand balance

3. **Creates periodic snapshots** (every 10 updates)
4. **Emits price update events** for WebSocket potential

### Starting Simulation

```typescript
import { initPriceHeatmap, startPriceSimulation } from './lib/priceHeatmap.js';

// Initialize database and zones
initPriceHeatmap();

// Start real-time simulation (5000ms intervals)
startPriceSimulation(5000);
```

### Stopping Simulation

```typescript
import { stopPriceSimulation } from './lib/priceHeatmap.js';

stopPriceSimulation();
```

## Real-Time Subscriptions

The system supports WebSocket-ready subscriptions:

```typescript
import { subscribeToPriceUpdates } from './lib/priceHeatmap.js';

// Subscribe to price updates
const unsubscribe = subscribeToPriceUpdates((priceData) => {
  console.log(`Zone ${priceData.zoneId}: $${priceData.price}/kWh`);
  
  // Push to WebSocket clients
  wss.clients.forEach(client => {
    client.send(JSON.stringify({
      type: 'priceUpdate',
      data: priceData
    }));
  });
});

// Later: unsubscribe
unsubscribe();
```

## Testing

### Manual Testing

1. **Start backend:**
   ```bash
   cd backend
   npm run dev
   ```

2. **View heatmap:**
   Navigate to the frontend page with the PriceHeatmap component

3. **Test live updates:**
   Watch prices update every 5 seconds with color changes

4. **Test historical playback:**
   - Click "Historical" button
   - Use play/pause controls
   - Scrub through timeline

5. **Test zone interaction:**
   - Click on any zone circle
   - View popup with details

### API Testing

```bash
# Get all zones
curl http://localhost:3001/api/heatmap/zones

# Get current heatmap data
curl http://localhost:3001/api/heatmap/current

# Get historical data (last hour)
curl "http://localhost:3001/api/heatmap/historical?startTime=2024-01-15T09:00:00Z&endTime=2024-01-15T10:00:00Z"

# Get zone statistics
curl http://localhost:3001/api/heatmap/zones/zone_5_5/stats

# Get summary
curl http://localhost:3001/api/heatmap/summary
```

## Performance

### Database Performance
- **WAL mode** for concurrent reads/writes
- **Composite indexes** for zone+timestamp queries
- **In-memory cache** for current prices
- **Batch inserts** for initial data

### Frontend Performance
- **CircleMarkers** instead of complex polygons
- **Memoized calculations** for color gradients
- **Debounced updates** (5 second intervals)
- **Optimized API endpoint** (`/current`) returns minimal data

### Scalability
- Tested with 100 zones
- Designed for 1000+ zones
- Snapshot system reduces database writes
- Pagination support (not yet implemented)

## Future Enhancements

### Potential Improvements
1. **WebSocket Support:** Real push notifications instead of polling
2. **Clustering:** Group nearby zones at low zoom levels
3. **Heat Layers:** Smooth gradient overlay instead of discrete circles
4. **Alerts:** Price spike notifications
5. **Predictions:** ML-based price forecasting
6. **Export:** Download historical data as CSV
7. **Comparison:** Side-by-side time periods
8. **Custom Zones:** User-defined geographic areas
9. **Integration:** Link to meter data and user locations
10. **Mobile App:** Native iOS/Android with push notifications

## Integration Points

### With Existing Features

1. **Meters:** Show meter location on heatmap
2. **Billing:** Use price data for cost predictions
3. **Analytics:** Price trend analysis
4. **Smart Home:** Optimize device usage based on prices
5. **Demand Response:** Trigger events based on price spikes

### Example: Show User's Meter on Heatmap

```typescript
// In your meter details page
import { PriceHeatmap } from '@/components/PriceHeatmap';

const meter = await getMeter(meterId);

<PriceHeatmap 
  highlightZone={meter.zoneId}
  centerLat={meter.latitude}
  centerLon={meter.longitude}
/>
```

## Troubleshooting

### Issue: Map not displaying
**Solution:** Ensure Leaflet CSS is loaded:
```typescript
import 'leaflet/dist/leaflet.css';
```

### Issue: Prices not updating
**Solution:** Check that price simulation is running:
```bash
# Backend logs should show:
# "Price simulation started"
```

### Issue: Historical data empty
**Solution:** Wait for snapshots to accumulate (created every 50 seconds by default)

### Issue: Performance degradation
**Solution:** 
- Check database size: `du -h data/price_heatmap.sqlite`
- Rebuild indexes if needed
- Consider archiving old data

## License

MIT - Same as Stellar Solar Grid project

## Issue Reference

**GitHub Issue:** #922  
**Title:** Interactive Energy Price Heatmap  
**Status:** ✅ Completed

## Contributors

Built as part of the Stellar Solar Grid platform enhancement.
