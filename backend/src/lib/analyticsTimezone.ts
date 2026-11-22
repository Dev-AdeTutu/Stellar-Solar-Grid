/**
 * Timezone-aware bucket helpers for analytics aggregation (#1153).
 *
 * The previous implementation grouped rows using Date.toISOString() and UTC
 * getters, so a row at 23:30 in America/New_York landed in the next UTC day.
 * These helpers derive calendar buckets in the requested IANA timezone.
 */

export type AnalyticsGranularity = "daily" | "weekly" | "monthly";

const pad = (value: number): string => String(value).padStart(2, "0");

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the timezone to use, or null when an explicitly supplied value is
 * invalid. Empty values fall back to UTC.
 */
export function resolveTimezone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "UTC";
  if (typeof value !== "string") return null;
  const timezone = value.trim();
  if (!timezone) return "UTC";
  return isValidTimezone(timezone) ? timezone : null;
}

export type BucketFormatter = (
  date: Date,
  granularity: AnalyticsGranularity
) => string;

/** Create one formatter per request and reuse it for every row. */
export function createBucketFormatter(timezone: string): BucketFormatter {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return (date: Date, granularity: AnalyticsGranularity): string => {
    const parts = formatter.formatToParts(date);
    const part = (type: string): string =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    const year = Number(part("year"));
    const month = Number(part("month"));
    const day = Number(part("day"));

    if (granularity === "monthly") return `${year}-${pad(month)}`;
    if (granularity === "daily") return `${year}-${pad(month)}-${pad(day)}`;

    const monday = new Date(Date.UTC(year, month - 1, day));
    const weekday = monday.getUTCDay();
    monday.setUTCDate(monday.getUTCDate() - ((weekday + 6) % 7));
    return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
  };
}
