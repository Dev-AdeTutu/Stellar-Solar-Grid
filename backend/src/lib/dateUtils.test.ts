/**
 * Tests for UTC date utilities
 * 
 * These tests run in different timezone environments to ensure
 * consistent behavior regardless of server timezone (Issue #XXX).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  parseUTCDate,
  getUTCStartOfToday,
  getUTCEndOfToday,
  formatUTCDate,
  getUTCDateDaysAgo,
  buildUTCDayRange,
  getUTCTimestampDaysAgo,
  isValidDateString,
  getUTCDateRange,
} from './dateUtils.js';

describe('dateUtils - UTC timezone handling', () => {
  let originalTZ: string | undefined;

  beforeEach(() => {
    originalTZ = process.env.TZ;
  });

  afterEach(() => {
    if (originalTZ) {
      process.env.TZ = originalTZ;
    } else {
      delete process.env.TZ;
    }
  });

  describe('parseUTCDate', () => {
    it('should parse date string as midnight UTC', () => {
      const timestamp = parseUTCDate('2025-08-25');
      const date = new Date(timestamp);
      
      expect(date.toISOString()).toBe('2025-08-25T00:00:00.000Z');
    });

    it('should produce same result in different timezones', () => {
      const dateStr = '2025-08-25';
      
      process.env.TZ = 'UTC';
      const utcResult = parseUTCDate(dateStr);
      
      process.env.TZ = 'Africa/Nairobi'; // UTC+3
      const eafricaResult = parseUTCDate(dateStr);
      
      process.env.TZ = 'America/Los_Angeles'; // UTC-7/8
      const usResult = parseUTCDate(dateStr);
      
      expect(utcResult).toBe(eafricaResult);
      expect(utcResult).toBe(usResult);
    });

    it('should throw error for invalid date string', () => {
      expect(() => parseUTCDate('invalid')).toThrow('Invalid date string');
      expect(() => parseUTCDate('2025-13-01')).toThrow('Invalid date string');
      expect(() => parseUTCDate('2025-02-30')).toThrow('Invalid date string');
    });
  });

  describe('formatUTCDate', () => {
    it('should format timestamp as UTC date string', () => {
      const timestamp = Date.UTC(2025, 7, 25); // August 25, 2025 (month is 0-indexed)
      expect(formatUTCDate(timestamp)).toBe('2025-08-25');
    });

    it('should produce same result in different timezones', () => {
      const timestamp = Date.UTC(2025, 7, 25);
      
      process.env.TZ = 'UTC';
      const utcResult = formatUTCDate(timestamp);
      
      process.env.TZ = 'Africa/Nairobi';
      const eafricaResult = formatUTCDate(timestamp);
      
      process.env.TZ = 'America/Los_Angeles';
      const usResult = formatUTCDate(timestamp);
      
      expect(utcResult).toBe('2025-08-25');
      expect(eafricaResult).toBe('2025-08-25');
      expect(usResult).toBe('2025-08-25');
    });
  });

  describe('buildUTCDayRange', () => {
    it('should build array of UTC date strings', () => {
      // Mock current date to 2025-08-25
      const mockNow = Date.UTC(2025, 7, 25);
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      jest.spyOn(global, 'Date').mockImplementation(((...args: any[]) => {
        if (args.length === 0) {
          return new (Date as any)(mockNow);
        }
        return new (Date as any)(...args);
      }) as any);

      const range = buildUTCDayRange(3);
      
      expect(range).toEqual([
        '2025-08-23',
        '2025-08-24',
        '2025-08-25',
      ]);

      jest.restoreAllMocks();
    });

    it('should produce same result in different timezones', () => {
      const mockNow = Date.UTC(2025, 7, 25, 23, 59, 59); // End of day UTC
      
      process.env.TZ = 'UTC';
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      const utcRange = buildUTCDayRange(2);
      jest.restoreAllMocks();
      
      process.env.TZ = 'Africa/Nairobi'; // UTC+3 (would be next day 02:59:59)
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      const eafricaRange = buildUTCDayRange(2);
      jest.restoreAllMocks();
      
      process.env.TZ = 'America/Los_Angeles'; // UTC-7 (would be previous day 16:59:59)
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      const usRange = buildUTCDayRange(2);
      jest.restoreAllMocks();
      
      // All should produce same UTC dates
      expect(utcRange).toEqual(eafricaRange);
      expect(utcRange).toEqual(usRange);
      expect(utcRange).toEqual(['2025-08-24', '2025-08-25']);
    });

    it('should handle single day range', () => {
      const mockNow = Date.UTC(2025, 7, 25);
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const range = buildUTCDayRange(1);
      expect(range).toEqual(['2025-08-25']);

      jest.restoreAllMocks();
    });
  });

  describe('isValidDateString', () => {
    it('should validate correct date strings', () => {
      expect(isValidDateString('2025-08-25')).toBe(true);
      expect(isValidDateString('2025-01-01')).toBe(true);
      expect(isValidDateString('2025-12-31')).toBe(true);
    });

    it('should reject invalid date strings', () => {
      expect(isValidDateString('2025-13-01')).toBe(false); // Invalid month
      expect(isValidDateString('2025-02-30')).toBe(false); // Invalid day
      expect(isValidDateString('25-08-2025')).toBe(false); // Wrong format
      expect(isValidDateString('2025/08/25')).toBe(false); // Wrong separator
      expect(isValidDateString('invalid')).toBe(false);
      expect(isValidDateString('')).toBe(false);
      expect(isValidDateString(null as any)).toBe(false);
    });
  });

  describe('getUTCDateRange', () => {
    it('should return start and end timestamps for date range', () => {
      const range = getUTCDateRange('2025-08-01', '2025-08-03');
      
      expect(range.start).toBe(Date.UTC(2025, 7, 1, 0, 0, 0, 0));
      expect(range.end).toBe(Date.UTC(2025, 7, 3, 23, 59, 59, 999));
    });

    it('should throw error if start is after end', () => {
      expect(() => getUTCDateRange('2025-08-25', '2025-08-20'))
        .toThrow('Invalid date range');
    });

    it('should handle same start and end date', () => {
      const range = getUTCDateRange('2025-08-25', '2025-08-25');
      
      expect(range.start).toBe(Date.UTC(2025, 7, 25, 0, 0, 0, 0));
      expect(range.end).toBe(Date.UTC(2025, 7, 25, 23, 59, 59, 999));
    });

    it('should produce same result in different timezones', () => {
      const startDate = '2025-08-01';
      const endDate = '2025-08-31';
      
      process.env.TZ = 'UTC';
      const utcRange = getUTCDateRange(startDate, endDate);
      
      process.env.TZ = 'Africa/Nairobi';
      const eafricaRange = getUTCDateRange(startDate, endDate);
      
      process.env.TZ = 'America/Los_Angeles';
      const usRange = getUTCDateRange(startDate, endDate);
      
      expect(utcRange.start).toBe(eafricaRange.start);
      expect(utcRange.start).toBe(usRange.start);
      expect(utcRange.end).toBe(eafricaRange.end);
      expect(utcRange.end).toBe(usRange.end);
    });
  });

  describe('getUTCTimestampDaysAgo', () => {
    it('should calculate timestamp for N days ago', () => {
      const mockNow = Date.UTC(2025, 7, 25, 12, 0, 0, 0); // Noon UTC
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const sevenDaysAgo = getUTCTimestampDaysAgo(7);
      const expected = mockNow - (7 * 24 * 60 * 60 * 1000);
      
      expect(sevenDaysAgo).toBe(expected);

      jest.restoreAllMocks();
    });

    it('should produce same result in different timezones', () => {
      const mockNow = Date.UTC(2025, 7, 25, 12, 0, 0, 0);
      
      process.env.TZ = 'UTC';
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      const utcResult = getUTCTimestampDaysAgo(30);
      jest.restoreAllMocks();
      
      process.env.TZ = 'Africa/Nairobi';
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      const eafricaResult = getUTCTimestampDaysAgo(30);
      jest.restoreAllMocks();
      
      process.env.TZ = 'America/Los_Angeles';
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      const usResult = getUTCTimestampDaysAgo(30);
      jest.restoreAllMocks();
      
      expect(utcResult).toBe(eafricaResult);
      expect(utcResult).toBe(usResult);
    });
  });

  describe('getUTCStartOfToday and getUTCEndOfToday', () => {
    it('should return start and end of current UTC day', () => {
      const mockNow = Date.UTC(2025, 7, 25, 15, 30, 45, 123); // Middle of day
      jest.spyOn(global, 'Date').mockImplementation(((...args: any[]) => {
        if (args.length === 0) {
          return new (Date as any)(mockNow);
        }
        return new (Date as any)(...args);
      }) as any);

      const start = getUTCStartOfToday();
      const end = getUTCEndOfToday();
      
      expect(start).toBe(Date.UTC(2025, 7, 25, 0, 0, 0, 0));
      expect(end).toBe(Date.UTC(2025, 7, 25, 23, 59, 59, 999));

      jest.restoreAllMocks();
    });
  });
});
