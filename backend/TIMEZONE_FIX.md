# Timezone Bug Fix

## Problem

Backend was mixing `Date()` constructor (local timezone) with timestamp comparisons (UTC), causing incorrect date range queries and statistics that varied based on server timezone.

### Symptoms

- Query `GET /api/stats/revenue-history?days=30` returns different results when deployed in different timezones
- Date boundary logic produces inconsistent behavior across deployments
- Top consumers list varies based on server timezone
- Purge operations affect different date ranges depending on timezone

### Root Cause

```typescript
// ❌ BEFORE: Uses server's local timezone
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const d = new Date(now);
d.setUTCDate(d.getUTCDate() - i); // Mixed UTC/local operations
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
```

These patterns create timezone-dependent behavior:
1. `new Date()` without timezone indicator uses local timezone
2. Mixing UTC methods with local Date objects creates subtle bugs
3. Date arithmetic doesn't account for DST transitions
4. ISO string generation can produce different dates in different timezones

## Solution

Created a centralized UTC-only date utility module (`dateUtils.ts`) that enforces consistent UTC handling across the codebase.

### Key Principles

1. **Never use implicit local timezone** - Always append `'Z'` suffix or use explicit UTC methods
2. **Use Unix timestamps for comparisons** - Milliseconds since epoch are timezone-agnostic
3. **Return ISO strings in UTC** - Format as `YYYY-MM-DD` for consistency
4. **Explicit UTC construction** - Use `Date.UTC()` for date creation

### Fixed Code

```typescript
// ✅ AFTER: Uses UTC everywhere
import { getUTCTimestampDaysAgo, buildUTCDayRange, formatUTCDate } from '../lib/dateUtils.js';

const cutoff = getUTCTimestampDaysAgo(days); // Explicit UTC
const dateRange = buildUTCDayRange(days); // Explicit UTC
const date = formatUTCDate(timestamp); // Always UTC
```

## Files Changed

### Created

- **`backend/src/lib/dateUtils.ts`** - UTC-only date utility functions
- **`backend/src/lib/dateUtils.test.ts`** - Comprehensive timezone tests

### Modified

- **`backend/src/routes/stats.ts`** 
  - Fixed `fetchRevenueHistory()` cutoff calculation
  - Replaced `buildDayRange()` with `buildUTCDayRange()`
  - Fixed date formatting to use `formatUTCDate()`

- **`backend/src/lib/usageEvents.ts`**
  - Fixed `getTopConsumers()` date cutoff
  - Fixed `purgeSubmittedUsageEvents()` date cutoff

## Testing

### Unit Tests

Run timezone tests in different environments:

```bash
# Test in UTC
TZ=UTC npm test dateUtils.test.ts

# Test in East Africa Time (UTC+3)
TZ=Africa/Nairobi npm test dateUtils.test.ts

# Test in Pacific Time (UTC-7/8)
TZ=America/Los_Angeles npm test dateUtils.test.ts
```

All tests should produce identical results regardless of `TZ` environment variable.

### Integration Tests

1. Deploy backend in UTC timezone
2. Query `GET /api/stats/revenue-history?days=30`
3. Record results
4. Redeploy in Africa/Nairobi (UTC+3)
5. Query same endpoint
6. Verify results are identical

## Migration Guide

### Before Deploying

1. Run tests in multiple timezone environments to verify consistency
2. Compare results from production (current timezone) with test environment (UTC)
3. Document any expected differences in historical data (old timezone bugs)

### After Deploying

1. Monitor stats endpoints for consistency
2. Verify purge operations affect correct date ranges
3. Check top consumers list remains stable across deployments

## API Contract

### Date Format

All date parameters and responses use **YYYY-MM-DD format in UTC**.

```typescript
// Request
GET /api/stats/revenue-history?days=30

// Response
{
  "history": [
    {
      "date": "2025-08-01",  // Always UTC
      "revenue_xlm": 150.5
    }
  ]
}
```

### Timezone Handling

- **Input**: Date strings without timezone are treated as UTC midnight (`YYYY-MM-DDT00:00:00.000Z`)
- **Output**: All timestamps are formatted as UTC ISO strings
- **Storage**: SQLite stores as ISO8601 strings in UTC
- **Comparisons**: Always use Unix timestamps (milliseconds)

## Future Improvements

1. Consider using `date-fns-tz` or `luxon` for more advanced timezone operations
2. Add request header for client timezone (display purposes only)
3. Include timezone metadata in API responses for transparency
4. Add monitoring alerts for timezone-dependent behavior

## References

- Issue: #XXX - Timezone-dependent date range queries
- Test Coverage: `backend/src/lib/dateUtils.test.ts`
- Documentation: This file

---

**Note**: This fix only affects date boundary calculations and aggregations. Individual event timestamps (`received_at`, `last_attempt_at`, etc.) continue to use UTC ISO strings as before.
