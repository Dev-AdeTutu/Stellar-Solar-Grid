# Implementation Plan: Climate Risk Assessment System

This plan implements a comprehensive climate risk assessment system for solar infrastructure. The work is decomposed into 4 features (FEAT-001 through FEAT-004) executed sequentially. Each feature is independently verifiable and leaves the codebase in a buildable state.

## Prerequisites

The approved technical design is at `.agents/tasks/climate-design.md`. All implementation follows that design specification.

---

## FEAT-001: Backend Climate Data Integration & Risk Engine

**What:** Core backend services for fetching climate projections from Open-Meteo Climate API, caching in Redis (with SQLite fallback), calculating risk scores, and storing assessments.

**Files:**
- CREATE `backend/data/climate-risk.sqlite` (auto-created by better-sqlite3)
- CREATE `backend/src/lib/climateData.ts`
- CREATE `backend/src/lib/climateRisk.ts`
- CREATE `backend/tests/climateData.test.ts`
- CREATE `backend/tests/climateRisk.test.ts`

**Verify:** 
```bash
cd backend && npm run build  # Compiles without errors
cd backend && npm run test   # All unit tests pass
```

---

## FEAT-002: Backend API Routes

**What:** Six Express routes for climate risk assessment endpoints with input validation, error handling, and integration tests.

**Files:**
- CREATE `backend/src/routes/climateRisk.ts`
- MODIFY `backend/src/index.ts` (register climateRiskRouter)
- CREATE `backend/tests/climateRisk.integration.test.ts`

**Verify:**
```bash
cd backend && npm run build  # Compiles without errors
cd backend && npm run test   # All integration tests pass including new climateRisk.integration.test.ts
```

---

## FEAT-003: Frontend Climate Risk Dashboard

**What:** React/Next.js components for visualizing climate risk data with Leaflet map, Recharts graphs, and mitigation checklist.

**Files:**
- CREATE `frontend/src/components/ClimateRiskDashboard.tsx`
- CREATE `frontend/src/components/FleetRiskMap.tsx`
- CREATE `frontend/src/components/RiskDistributionChart.tsx`
- CREATE `frontend/src/components/MeterRiskDetail.tsx`
- CREATE `frontend/src/components/ScenarioComparisonChart.tsx`
- CREATE `frontend/src/components/MitigationList.tsx`
- CREATE `frontend/src/components/InsuranceTierBadge.tsx`
- CREATE `frontend/src/app/climate-risk/page.tsx` (or integrate into existing navigation)

**Verify:**
```bash
cd frontend && npm run build  # Compiles without errors
```

Manual verification in dev mode:
```bash
cd frontend && npm run dev
# Navigate to /climate-risk, verify map renders, click meter marker opens modal
```

---

## FEAT-004: Documentation

**What:** Comprehensive documentation covering system architecture, API reference, risk methodology, troubleshooting, and deployment.

**Files:**
- CREATE `docs/CLIMATE_RISK.md`

**Verify:**
- Confirm file exists with all 10 required sections
- Check markdown formatting renders correctly
- Verify API examples and curl commands are accurate

---

## Integration Verification

After all features complete:

1. **Backend build:** `cd backend && npm run build`
2. **Backend tests:** `cd backend && npm run test`
3. **Frontend build:** `cd frontend && npm run build`
4. **Manual E2E test:**
   - Start backend: `cd backend && npm run dev`
   - Start frontend: `cd frontend && npm run dev`
   - Register test meter with location via API or device registry
   - Access climate risk dashboard
   - Verify fleet map displays
   - Click meter marker, verify detail modal opens with scenario charts
   - Update mitigation status, verify PATCH request succeeds

5. **Check logs:** Verify no errors in `backend/logs/error.log`

---

## Notes

- Redis is optional; system gracefully degrades to SQLite-only mode
- Climate APIs (Open-Meteo) are rate-limited to 1 req/sec
- Meter locations must be numeric coordinates (JSON `{"lat": 37.7, "lon": -122.4}` or CSV `"37.7,-122.4"`)
- All database schemas initialize automatically on first run
- Commit after each feature completes
