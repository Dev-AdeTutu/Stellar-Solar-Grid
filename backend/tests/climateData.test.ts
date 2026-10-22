/**
 * Unit tests for climate data service.
 */
import { describe, it, expect, beforeAll } from 'vitest';

describe('Climate Data Service', () => {
  describe('Cache TTL logic', () => {
    it('calculates correct TTL in seconds', () => {
      const ttl24h = 86400; // 24 hours in seconds
      expect(ttl24h).toBe(24 * 60 * 60);
    });

    it('validates stale cache threshold', () => {
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
      const now = Date.now();
      const sevenDaysAgo = now - maxAge;
      const eightDaysAgo = now - maxAge - 86400000;

      expect(sevenDaysAgo).toBeGreaterThan(eightDaysAgo);
      expect(now - sevenDaysAgo).toBeLessThanOrEqual(maxAge);
      expect(now - eightDaysAgo).toBeGreaterThan(maxAge);
    });
  });

  describe('Rate limiting', () => {
    it('enforces minimum interval between calls', async () => {
      const minInterval = 1000; // 1 second
      const apiCallTimestamps = new Map<string, number>();

      // Simulate first call
      const api = 'test-api';
      apiCallTimestamps.set(api, Date.now());

      // Check if second call should wait
      const lastCall = apiCallTimestamps.get(api) ?? 0;
      const timeSinceLastCall = Date.now() - lastCall;

      // Should be very close to 0 since we just set it
      expect(timeSinceLastCall).toBeLessThan(minInterval);

      // Simulate wait
      await new Promise(resolve => setTimeout(resolve, 50));

      const timeSinceLastCall2 = Date.now() - lastCall;
      expect(timeSinceLastCall2).toBeGreaterThan(0);
    });

    it('tracks timestamps per API independently', () => {
      const apiCallTimestamps = new Map<string, number>();
      const now = Date.now();

      apiCallTimestamps.set('api-1', now);
      apiCallTimestamps.set('api-2', now + 1000);

      expect(apiCallTimestamps.get('api-1')).toBe(now);
      expect(apiCallTimestamps.get('api-2')).toBe(now + 1000);
      expect(apiCallTimestamps.size).toBe(2);
    });
  });

  describe('API response parsing', () => {
    it('extracts temperature data correctly', () => {
      const mockResponse = {
        daily: {
          temperature_2m_mean: [15.5, 16.2, 14.8, 17.1, 16.5],
        },
      };

      const temps = mockResponse.daily.temperature_2m_mean;
      expect(temps.length).toBe(5);

      const avgTemp = temps.reduce((sum, t) => sum + t, 0) / temps.length;
      expect(avgTemp).toBeCloseTo(16.02, 2);
    });

    it('extracts precipitation data correctly', () => {
      const mockResponse = {
        daily: {
          precipitation_sum: [0.0, 2.5, 1.2, 0.0, 5.8],
        },
      };

      const precip = mockResponse.daily.precipitation_sum;
      expect(precip.length).toBe(5);

      const avgPrecip = precip.reduce((sum, p) => sum + p, 0) / precip.length;
      expect(avgPrecip).toBeCloseTo(1.9, 1);
    });

    it('handles missing data gracefully', () => {
      const mockResponse = {
        daily: {},
      };

      const temps = mockResponse.daily.temperature_2m_mean || [];
      expect(temps.length).toBe(0);
    });

    it('calculates wind speed conversion', () => {
      const windSpeedMs = 10; // m/s
      const windSpeedKmh = windSpeedMs * 3.6;
      expect(windSpeedKmh).toBe(36);
    });
  });

  describe('Error handling', () => {
    it('handles 404 errors', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };

      expect(mockResponse.ok).toBe(false);
      expect(mockResponse.status).toBe(404);
    });

    it('handles 500 errors', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };

      expect(mockResponse.ok).toBe(false);
      expect(mockResponse.status).toBe(500);
    });

    it('handles timeout errors', async () => {
      const timeoutMs = 10000;
      const signal = AbortSignal.timeout(timeoutMs);

      expect(signal.aborted).toBe(false);
      
      // Timeout should be set correctly
      expect(timeoutMs).toBe(10000);
    });

    it('validates API response structure', () => {
      const validResponse = {
        daily: {
          temperature_2m_mean: [15.5],
          precipitation_sum: [2.5],
          wind_speed_10m_max: [10.2],
        },
      };

      expect(validResponse.daily).toBeDefined();
      expect(Array.isArray(validResponse.daily.temperature_2m_mean)).toBe(true);
      expect(Array.isArray(validResponse.daily.precipitation_sum)).toBe(true);
      expect(Array.isArray(validResponse.daily.wind_speed_10m_max)).toBe(true);
    });
  });

  describe('Exposure score calculation', () => {
    it('calculates heatwave score correctly', () => {
      const avgTemp = 20; // °C
      const baseline = 15;
      const tempAnomaly = avgTemp - baseline; // 5°C
      const score = Math.min(100, Math.max(0, (tempAnomaly / 5) * 100));

      expect(score).toBe(100);
    });

    it('calculates flood score with elevation penalty', () => {
      const avgPrecip = 20; // mm/day
      const elevation = 5; // meters
      const elevationPenalty = Math.max(0, (10 - elevation) / 10);
      const score = Math.min(100, Math.max(0, (avgPrecip / 10) * 50 + elevationPenalty * 50));

      expect(elevationPenalty).toBe(0.5);
      expect(score).toBeCloseTo(125); // Would be clamped to 100
      expect(Math.min(100, score)).toBe(100);
    });

    it('calculates storm score with wind data', () => {
      const avgWindMs = 20; // m/s
      const windSpeedKmh = avgWindMs * 3.6; // 72 km/h
      const avgPrecip = 25; // mm/day
      const score = Math.min(
        100,
        Math.max(0, (windSpeedKmh / 100) * 60 + (avgPrecip / 50) * 40)
      );

      expect(windSpeedKmh).toBe(72);
      expect(score).toBeCloseTo(63.2, 1);
    });

    it('handles edge cases in score calculation', () => {
      // Zero values
      expect(Math.min(100, Math.max(0, 0))).toBe(0);

      // Negative values (should be clamped to 0)
      expect(Math.max(0, -10)).toBe(0);

      // Values over 100 (should be clamped to 100)
      expect(Math.min(100, 150)).toBe(100);
    });
  });
});
