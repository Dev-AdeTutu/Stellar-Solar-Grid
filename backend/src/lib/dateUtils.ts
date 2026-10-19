/**
 * Date utility functions that enforce UTC timezone handling.
 * 
 * All functions in this module work exclusively in UTC to prevent
 * timezone-dependent bugs where server results vary based on deployment
 * timezone (Issue #XXX).
 * 
 * Design principles:
 * - Never use Date() constructor with implicit local timezone
 * - Always append 'Z' suffix or use explicit UTC methods
 * - Return ISO strings in UTC (YYYY-MM-DD format)
 * - Use milliseconds (Unix epoch) for comparisons
 */

/**
 * Parse a date string in UTC, treating it as midnight UTC (00:00:00Z).
 * 
 * @param dateStr Date string in YYYY-MM-DD format
 * @returns Unix timestamp (milliseconds) for midnight UTC on that date
 * @throws Error if dateStr is invalid
 * 
 * @example
 * parseUTCDate('2025-08-25') // Returns timestamp for 2025-08-25T00:00:00.000Z
 */
export function parseUTCDate(dateStr: string): number {
  // Append explicit UTC timezone indicator to prevent local timezone interpretation
  const utcDateStr = `${dateStr}T00:00:00.000Z`;
  const timestamp = Date.parse(utcDateStr);
  
  if (isNaN(timestamp)) {
    throw new Error(`Invalid date string: ${dateStr}. Expected format: YYYY-MM-DD`);
  }
  
  return timestamp;
}

/**
 * Get the start of today in UTC (00:00:00Z).
 * 
 * @returns Unix timestamp (milliseconds) for the start of the current UTC day
 */
export function getUTCStartOfToday(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  
  return Date.UTC(year, month, date, 0, 0, 0, 0);
}

/**
 * Get the end of today in UTC (23:59:59.999Z).
 * 
 * @returns Unix timestamp (milliseconds) for the end of the current UTC day
 */
export function getUTCEndOfToday(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  
  return Date.UTC(year, month, date, 23, 59, 59, 999);
}

/**
 * Format a Unix timestamp as a UTC date string (YYYY-MM-DD).
 * 
 * @param timestamp Unix timestamp in milliseconds
 * @returns Date string in YYYY-MM-DD format (UTC)
 * 
 * @example
 * formatUTCDate(1693785600000) // Returns '2023-09-04'
 */
export function formatUTCDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().slice(0, 10);
}

/**
 * Get the UTC date string for N days ago from today.
 * 
 * @param daysAgo Number of days to subtract (positive integer)
 * @returns Date string in YYYY-MM-DD format (UTC)
 * 
 * @example
 * getUTCDateDaysAgo(7) // Returns date string for 7 days ago in UTC
 */
export function getUTCDateDaysAgo(daysAgo: number): string {
  const now = new Date();
  const timestamp = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo,
    0,
    0,
    0,
    0
  );
  return formatUTCDate(timestamp);
}

/**
 * Build an array of UTC date strings for the past N days (inclusive of today).
 * 
 * @param days Number of days to include (1 = today only, 7 = last 7 days)
 * @returns Array of date strings in YYYY-MM-DD format, oldest to newest
 * 
 * @example
 * buildUTCDayRange(3)
 * // Returns ['2025-08-23', '2025-08-24', '2025-08-25'] (if today is 2025-08-25)
 */
export function buildUTCDayRange(days: number): string[] {
  const result: string[] = [];
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  
  for (let i = days - 1; i >= 0; i--) {
    const timestamp = todayUTC - (i * 24 * 60 * 60 * 1000);
    result.push(formatUTCDate(timestamp));
  }
  
  return result;
}

/**
 * Get the Unix timestamp (milliseconds) for N days ago from now.
 * 
 * @param days Number of days to subtract
 * @returns Unix timestamp in milliseconds
 * 
 * @example
 * getUTCTimestampDaysAgo(30) // Returns timestamp for 30 days ago
 */
export function getUTCTimestampDaysAgo(days: number): number {
  const now = Date.now();
  return now - (days * 24 * 60 * 60 * 1000);
}

/**
 * Validate a date string format (YYYY-MM-DD).
 * 
 * @param dateStr Date string to validate
 * @returns true if valid YYYY-MM-DD format, false otherwise
 */
export function isValidDateString(dateStr: string): boolean {
  if (typeof dateStr !== 'string') return false;
  
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;
  
  try {
    parseUTCDate(dateStr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the start and end timestamps for a date range in UTC.
 * 
 * @param startDate Start date string (YYYY-MM-DD)
 * @param endDate End date string (YYYY-MM-DD)
 * @returns Object with start and end Unix timestamps (milliseconds)
 * @throws Error if date strings are invalid or start > end
 * 
 * @example
 * getUTCDateRange('2025-08-01', '2025-08-31')
 * // Returns { start: 1722470400000, end: 1725148799999 }
 */
export function getUTCDateRange(startDate: string, endDate: string): { start: number; end: number } {
  const start = parseUTCDate(startDate);
  const end = parseUTCDate(endDate) + (24 * 60 * 60 * 1000 - 1); // End of day
  
  if (start > end) {
    throw new Error(`Invalid date range: start date (${startDate}) is after end date (${endDate})`);
  }
  
  return { start, end };
}
