# Climate Risk Assessment System

## Overview

The Climate Risk Assessment system provides comprehensive climate change risk analysis for solar infrastructure. It integrates climate projection datasets, assesses physical risks (floods, heat waves, storms) per meter location, calculates risk scores across multiple climate scenarios, and recommends mitigation strategies with insurance-grade risk tiers.

**Key Capabilities:**
- ✅ Climate data integration from Open-Meteo Climate API
- ✅ Risk modeling for flood, heatwave, and storm hazards
- ✅ Multi-scenario analysis (RCP 4.5, RCP 8.5, SSP2, SSP5)
- ✅ Mitigation recommendations with cost estimates
- ✅ Insurance tier classification (low/moderate/high/critical)
- ✅ Fleet-wide risk summary and distribution
- ✅ Redis caching with SQLite persistence
- ✅ Frontend risk dashboard with interactive maps

---

## Architecture

### Components

**Backend Services:**
- `backend/src/lib/climateData.ts` - Climate data fetching and caching
- `backend/src/lib/climateRisk.ts` - Risk assessment engine and scoring algorithms
- `backend/src/routes/climateRisk.ts` - RESTful API endpoints

**Frontend Dashboard:**
- `frontend/src/components/ClimateRiskDashboard.tsx` - Main dashboard component
- `frontend/src/components/FleetRiskMap.tsx` - Interactive map visualization
- `frontend/src/components/RiskDistributionChart.tsx` - Risk distribution charts
- `frontend/src/components/MeterRiskDetail.tsx` - Individual meter details
- `frontend/src/components/MitigationList.tsx` - Mitigation recommendations

**Database:**
- `data/climate-risk.sqlite` - Climate projections, risk assessments, mitigation plans

---

## API Reference

### Base URL
All endpoints are under `/api/climate-risk`

### Endpoints

#### 1. Assess Meter Risk
```http
GET /api/climate-risk/assess/:meterId?scenario=RCP8.5
```

**Description:** Assess climate risk for a single solar meter.

**Parameters:**
- `meterId` (path) - Meter identifier
- `scenario` (query, optional) - Climate scenario: `RCP4.5`, `RCP8.5` (default), `SSP2`, `SSP5`

**Response:**
```json
{
  "meterId": "METER-001",
  "lat": 37.7749,
  "lon": -122.4194,
  "scenario": "RCP8.5",
  "overallRiskScore": 68.5,
  "floodScore": 72.0,
  "heatwaveScore": 81.0,
  "stormScore": 52.5,
  "insuranceTier": "high",
  "assessedAt": "2026-10-22T10:30:00.000Z"
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid scenario
- `404` - Meter not found or location unavailable

---

#### 2. Fleet Risk Summary
```http
GET /api/climate-risk/fleet?scenario=RCP8.5
```

**Description:** Get fleet-wide risk summary with distribution by tier.

**Parameters:**
- `scenario` (query, optional) - Climate scenario (default: `RCP8.5`)

**Response:**
```json
{
  "totalMeters": 156,
  "riskDistribution": {
    "low": 45,
    "moderate": 68,
    "high": 32,
    "critical": 11
  },
  "averageRiskScore": 58.3,
  "highRiskMeters": [
    {
      "meterId": "METER-042",
      "riskScore": 89.2,
      "location": { "lat": 37.8, "lon": -122.5 }
    }
  ],
  "mitigationCoverage": 0.65,
  "assessedAt": "2026-10-22T10:30:00.000Z"
}
```

---

#### 3. Scenario Breakdown
```http
GET /api/climate-risk/scenarios/:meterId
```

**Description:** Detailed risk breakdown across all 4 climate scenarios for a single meter.

**Response:**
```json
{
  "meterId": "METER-001",
  "scenarios": [
    {
      "meterId": "METER-001",
      "scenario": "RCP4.5",
      "overallRiskScore": 52.3,
      "floodScore": 48.0,
      "heatwaveScore": 62.0,
      "stormScore": 47.0,
      "insuranceTier": "moderate",
      "lat": 37.7749,
      "lon": -122.4194,
      "assessedAt": "2026-10-22T10:30:00.000Z"
    },
    ...
  ],
  "comparisonSummary": {
    "bestCase": { "scenario": "RCP4.5", "overallRiskScore": 52.3, ... },
    "worstCase": { "scenario": "RCP8.5", "overallRiskScore": 78.9, ... }
  }
}
```

---

#### 4. Refresh Climate Data
```http
POST /api/climate-risk/refresh/:meterId
```

**Description:** Force refresh climate data from APIs (bypasses cache).

**Response:**
```json
{
  "success": true,
  "message": "Climate data refreshed",
  "meterId": "METER-001",
  "location": { "lat": 37.7749, "lon": -122.4194 }
}
```

---

#### 5. Get Mitigation Plans
```http
GET /api/climate-risk/mitigation/:meterId
```

**Description:** Get mitigation recommendations for a meter.

**Response:**
```json
{
  "meterId": "METER-001",
  "plans": [
    {
      "id": 123,
      "meterId": "METER-001",
      "hazardType": "flood",
      "recommendation": "elevation",
      "priority": "high",
      "estimatedCostUsd": 5000,
      "implementationStatus": "pending",
      "details": {
        "description": "Elevate solar panels 2 feet above current height",
        "timeline": "3-6 months",
        "contractor": "Solar Safety Inc."
      },
      "createdAt": "2026-10-01T12:00:00.000Z",
      "updatedAt": "2026-10-01T12:00:00.000Z"
    }
  ]
}
```

---

#### 6. Update Mitigation Status
```http
PATCH /api/climate-risk/mitigation/:id
```

**Description:** Update mitigation plan implementation status.

**Request Body:**
```json
{
  "status": "in_progress",
  "details": {
    "description": "Contractor on-site, work started",
    "timeline": "Completion expected by Dec 2026"
  }
}
```

**Valid Status Values:** `pending`, `planned`, `in_progress`, `completed`

**Response:**
```json
{
  "id": 123,
  "meterId": "METER-001",
  "implementationStatus": "in_progress",
  "updatedAt": "2026-10-22T11:00:00.000Z",
  ...
}
```

---

## Risk Methodology

### Risk Scoring Algorithm

**Overall Risk Score** (0-100) is calculated as a weighted average:
```
overallRiskScore = (floodScore × 0.35) + (heatwaveScore × 0.35) + (stormScore × 0.30)
```

**Individual Hazard Scores** are derived from:
1. Climate projection exposure values (0-100 from Open-Meteo Climate API)
2. Scenario-specific multipliers (RCP8.5 and SSP5 have higher weights)
3. Geographic vulnerability factors

### Insurance Tier Classification

| Tier | Risk Score Range | Description |
|------|-----------------|-------------|
| **Low** | 0 - 30 | Minimal climate risk, standard insurance rates |
| **Moderate** | 31 - 60 | Moderate risk, some adaptation recommended |
| **High** | 61 - 80 | Significant risk, mitigation strongly advised |
| **Critical** | 81 - 100 | Severe risk, immediate action required |

### Climate Scenarios

| Scenario | Description | Temperature Rise by 2100 |
|----------|-------------|-------------------------|
| **RCP 4.5** | Moderate emissions, significant mitigation | +2.4°C |
| **RCP 8.5** | High emissions, business as usual | +4.3°C |
| **SSP2** | Middle-of-the-road pathway | +2.7°C |
| **SSP5** | Fossil-fueled development | +4.6°C |

---

## Mitigation Recommendations

The system automatically generates mitigation recommendations based on risk thresholds:

### Flood Mitigation
- **Elevation** (score > 60): Raise solar panels above projected flood levels
- **Flood Barriers** (score > 70): Install perimeter barriers or berms
- **Drainage Systems** (score > 50): Improve site drainage

### Heatwave Mitigation
- **Cooling Systems** (score > 65): Install active cooling for electronics
- **Shading** (score > 70): Add heat-reflective coatings or canopies
- **Panel Spacing** (score > 60): Increase ventilation gaps

### Storm Mitigation
- **Hardening** (score > 65): Reinforce mounting structures
- **Storm Shutters** (score > 75): Install protective covers for extreme events
- **Wind Breaks** (score > 60): Add windbreaks or barriers

### Priority Levels
- **Critical**: Score > 80, immediate action within 3 months
- **High**: Score 61-80, action within 6-12 months
- **Medium**: Score 41-60, plan within 1-2 years
- **Low**: Score < 40, monitor and reassess annually

---

## Frontend Dashboard

### Fleet Risk Map
Interactive map showing all meters color-coded by risk tier:
- 🟢 Green: Low risk
- 🟡 Yellow: Moderate risk
- 🟠 Orange: High risk
- 🔴 Red: Critical risk

Click any meter marker to view detailed risk breakdown.

### Risk Distribution Chart
Bar chart showing number of meters in each insurance tier, with scenario comparison.

### Meter Risk Detail
Modal view showing:
- Overall risk score gauge
- Scenario comparison chart (line chart)
- Individual hazard scores (bar chart)
- Mitigation recommendations list with status
- Historical risk trend (if available)

### Mitigation Tracking
Checklist interface for tracking mitigation plan progress:
- ☐ Pending
- 📋 Planned
- ⏳ In Progress
- ✅ Completed

---

## Data Sources

### Climate Projection APIs

**Primary:** [Open-Meteo Climate API](https://open-meteo.com/en/docs/climate-api)
- Free tier: 10,000 requests/day
- Provides climate model projections (CMIP6)
- Supports RCP and SSP scenarios
- Data: temperature, precipitation, extreme events

**Elevation:** [Open-Elevation API](https://open-elevation.com/)
- Used for flood risk assessment
- Provides terrain elevation data

### Caching Strategy
- **Redis Cache:** 24-hour TTL for API responses
- **SQLite Fallback:** 7-day stale data if APIs unavailable
- **Rate Limiting:** 1 request/second per API to respect free tier limits

---

## Database Schema

### climate_projections
Stores cached climate projection data per location.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| lat | REAL | Latitude |
| lon | REAL | Longitude |
| scenario | TEXT | Climate scenario (RCP4.5, RCP8.5, SSP2, SSP5) |
| hazard_type | TEXT | Hazard type (flood, heatwave, storm) |
| exposure_score | REAL | Exposure score (0-100) |
| projection_year | INTEGER | Year of projection (2030, 2050, 2100) |
| metadata | TEXT | JSON metadata |
| fetched_at | TEXT | ISO timestamp |

**Indexes:**
- `idx_climate_projections_location` on (lat, lon)
- `idx_climate_projections_scenario` on (scenario, hazard_type)

### risk_assessments
Stores calculated risk assessments per meter.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| meter_id | TEXT | Meter identifier |
| lat | REAL | Latitude |
| lon | REAL | Longitude |
| scenario | TEXT | Climate scenario |
| overall_risk_score | REAL | Overall risk score (0-100) |
| flood_score | REAL | Flood risk score |
| heatwave_score | REAL | Heatwave risk score |
| storm_score | REAL | Storm risk score |
| insurance_tier | TEXT | Insurance tier classification |
| assessed_at | TEXT | ISO timestamp |

**Indexes:**
- `idx_risk_assessments_meter` on (meter_id, assessed_at DESC)
- `idx_risk_assessments_tier` on (insurance_tier)

### mitigation_plans
Stores mitigation recommendations and implementation status.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| meter_id | TEXT | Meter identifier |
| hazard_type | TEXT | Hazard type |
| recommendation | TEXT | Recommendation type |
| priority | TEXT | Priority level |
| estimated_cost_usd | REAL | Estimated cost in USD |
| implementation_status | TEXT | Status (pending, planned, in_progress, completed) |
| details | TEXT | JSON details |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

**Indexes:**
- `idx_mitigation_plans_meter` on (meter_id)
- `idx_mitigation_plans_status` on (implementation_status)

---

## Configuration

### Environment Variables

```bash
# Redis (optional, graceful degradation if unavailable)
REDIS_HOST=localhost
REDIS_PORT=6379

# Database
SQLITE_DB_PATH=./data/climate-risk.sqlite

# API Rate Limits
CLIMATE_API_RATE_LIMIT=1  # requests per second

# Caching
CLIMATE_CACHE_TTL=86400  # 24 hours in seconds
CLIMATE_STALE_FALLBACK=604800  # 7 days in seconds
```

### Prerequisites

**Node.js:** v18+ (for native `fetch` API)

**Dependencies:**
- `better-sqlite3` v11.10+ - SQLite database
- `ioredis` v6.0+ - Redis client (optional)
- `express` v4.19+ - API router
- `winston` - Logging

**Frontend:**
- `next.js` v14.2+
- `react` v18.3+
- `recharts` v2.15+ - Charts
- `leaflet` - Maps

---

## Testing

### Unit Tests
```bash
cd backend
npm run test -- climateData.test.ts
npm run test -- climateRisk.test.ts
```

### Integration Tests
```bash
cd backend
npm run test -- climateRisk.integration.test.ts
```

**Test Coverage:**
- ✅ Climate data fetching and caching
- ✅ Risk score calculation across scenarios
- ✅ Mitigation recommendation generation
- ✅ Insurance tier classification
- ✅ Fleet risk aggregation
- ✅ API endpoint validation
- ✅ Error handling and graceful degradation

---

## Deployment

### Backend Deployment

1. **Install dependencies:**
```bash
cd backend
npm install
```

2. **Build TypeScript:**
```bash
npm run build
```

3. **Initialize database:**
Database schema is auto-created on first run.

4. **Start server:**
```bash
npm run start
```

### Frontend Deployment

1. **Install dependencies:**
```bash
cd frontend
npm install
```

2. **Build production:**
```bash
npm run build
```

3. **Start production server:**
```bash
npm run start
```

### Docker Deployment (Optional)

```yaml
# docker-compose.yml
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - REDIS_HOST=redis
    volumes:
      - ./data:/app/data
  
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  
  frontend:
    build: ./frontend
    ports:
      - "3001:3001"
    depends_on:
      - backend
```

---

## Troubleshooting

### Common Issues

#### 1. Meter location not found
**Error:** `404: Meter not found or location unavailable`

**Cause:** Meter has no location data in device registry.

**Solution:** Ensure meter records in device registry have valid `location` field:
```json
{"lat": 37.7749, "lon": -122.4194}
```
or CSV format:
```
"37.7749,-122.4194"
```

---

#### 2. Climate API rate limit exceeded
**Error:** `429: Too Many Requests`

**Cause:** Exceeded free tier limit of Open-Meteo API.

**Solution:**
- Requests are automatically rate-limited to 1/second
- Use cached data (24-hour TTL)
- Consider upgrading to Open-Meteo paid tier for higher limits

---

#### 3. Redis connection failed
**Error:** `Redis connection refused`

**Cause:** Redis server unavailable.

**Solution:** System automatically falls back to SQLite-only mode. Redis is optional. Check Redis server status:
```bash
redis-cli ping
```

---

#### 4. Invalid coordinates
**Error:** `Invalid coordinates`

**Cause:** Latitude/longitude out of valid range.

**Solution:** Ensure coordinates are:
- Latitude: -90 to 90
- Longitude: -180 to 180

---

#### 5. Stale risk data
**Issue:** Risk assessments not updating.

**Cause:** Cached data not expiring.

**Solution:** Force refresh:
```bash
curl -X POST http://localhost:3000/api/climate-risk/refresh/METER-ID
```

---

## Performance Considerations

### Caching Strategy
- **Redis cache** reduces API calls by 95%+
- **SQLite persistence** provides offline resilience
- **24-hour TTL** balances freshness vs. API quota

### Scalability
- Climate data is shared across meters in same location (deduplicated by lat/lon)
- Fleet-wide assessments use indexed queries
- Async processing for bulk assessments

### Optimization Tips
1. **Batch meter assessments** instead of individual requests
2. **Cache fleet summaries** for dashboard
3. **Precompute risk scores** during off-peak hours
4. **Use CDN** for frontend static assets

---

## Roadmap

### Future Enhancements
- [ ] Real-time weather alerts integration
- [ ] Machine learning for risk prediction refinement
- [ ] Historical risk trend analysis
- [ ] Automated insurance quote generation
- [ ] Integration with contractor networks for mitigation
- [ ] Mobile app for field inspections
- [ ] Wildfire risk assessment
- [ ] Sea level rise projections
- [ ] Community-level aggregation and planning

---

## Support & Contributing

### Documentation
- **Technical Design:** `.agents/tasks/climate-design.md`
- **Implementation Plan:** `.agents/tasks/plan.md`

### Reporting Issues
Submit issues via GitHub with:
- Meter ID (if applicable)
- API endpoint
- Request/response samples
- Error logs from `backend/logs/error.log`

### Contributing
See main project `CONTRIBUTING.md` for guidelines.

---

## License

See main project `LICENSE` file.

---

## Acknowledgments

**Data Sources:**
- [Open-Meteo Climate API](https://open-meteo.com/) - Climate projections
- [CMIP6](https://www.wcrp-climate.org/wgcm-cmip/wgcm-cmip6) - Climate model data
- [IPCC](https://www.ipcc.ch/) - Climate scenarios and methodology

**References:**
- IPCC Sixth Assessment Report (AR6)
- Climate Change 2021: The Physical Science Basis
- Global climate risk assessment frameworks

---

*Last Updated: October 22, 2026*
