/**
 * Provider revenue analytics calculations (#1002).
 *
 * Plain, dependency-free functions over an array of revenue rows — no
 * Express, no SQLite — so they're unit-testable without spinning up the
 * server, mirroring the bucketing helpers in routes/analytics.ts
 * (formatBucket/addBucket), but with real test coverage.
 *
 * All monetary figures in/out are in stroops (1 XLM = 10_000_000 stroops)
 * unless a field name says otherwise.
 */

export type RevenueGranularity = "daily" | "monthly" | "yearly";

export interface RevenueRow {
  paymentId: string;
  meterId: string;
  amount: number;
  payer?: string | null;
  region?: string | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

export const STROOPS_PER_XLM = 10_000_000;

export function stroopsToXlm(stroops: number): number {
  return stroops / STROOPS_PER_XLM;
}

/** Format a Date into a bucket key for the given granularity, in UTC. */
export function formatRevenueBucket(date: Date, granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return date.toISOString().slice(0, 10);
  }
  if (granularity === "yearly") {
    return String(date.getUTCFullYear());
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toDate(row: RevenueRow): Date {
  return new Date(row.createdAt);
}

function inRange(row: RevenueRow, from?: Date, to?: Date): boolean {
  const t = toDate(row).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < from.getTime()) return false;
  if (to && t > to.getTime()) return false;
  return true;
}

/** Sum of `amount` across all given rows. */
export function calculateTotalRevenue(rows: RevenueRow[]): number {
  return rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
}

/**
 * Monthly Recurring Revenue proxy: total revenue collected within the
 * calendar month (UTC) of `asOf`. The platform bills on a pay-as-you-go
 * basis rather than fixed subscriptions, so "MRR" here means "revenue
 * actually recognized this calendar month" rather than a committed
 * subscription run-rate.
 */
export function calculateMRR(rows: RevenueRow[], asOf: Date = new Date()): number {
  const bucket = formatRevenueBucket(asOf, "monthly");
  return rows
    .filter((r) => {
      const d = toDate(r);
      return !Number.isNaN(d.getTime()) && formatRevenueBucket(d, "monthly") === bucket;
    })
    .reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
}

/**
 * Average Revenue Per User (per paying meter) over the given rows:
 * total revenue / distinct paying meters. Returns 0 when there are no rows.
 */
export function calculateARPU(rows: RevenueRow[]): number {
  const customers = new Set(rows.map((r) => r.meterId));
  if (customers.size === 0) return 0;
  return calculateTotalRevenue(rows) / customers.size;
}

export interface ChurnResult {
  churnRate: number;
  retentionRate: number;
  previousPeriodCustomers: number;
  currentPeriodCustomers: number;
  retainedCustomers: number;
  churnedCustomers: number;
}

/**
 * Customer churn between two equal-length, back-to-back periods:
 * churnRate = customers active in the previous period who did NOT pay again
 * in the current period, divided by the previous period's customer count.
 *
 * "Customer" is approximated by meter_id, since the platform has no
 * separate subscriber identity distinct from a registered meter.
 */
export function calculateChurnRate(
  rows: RevenueRow[],
  periodStart: Date,
  periodEnd: Date,
): ChurnResult {
  const periodLengthMs = periodEnd.getTime() - periodStart.getTime();
  const previousStart = new Date(periodStart.getTime() - periodLengthMs);
  const previousEnd = periodStart;

  const previousCustomers = new Set(
    rows.filter((r) => inRange(r, previousStart, previousEnd)).map((r) => r.meterId),
  );
  const currentCustomers = new Set(
    rows.filter((r) => inRange(r, periodStart, periodEnd)).map((r) => r.meterId),
  );

  let retained = 0;
  for (const meterId of previousCustomers) {
    if (currentCustomers.has(meterId)) retained++;
  }
  const churned = previousCustomers.size - retained;
  const churnRate = previousCustomers.size === 0 ? 0 : churned / previousCustomers.size;

  return {
    churnRate,
    retentionRate: previousCustomers.size === 0 ? 1 : retained / previousCustomers.size,
    previousPeriodCustomers: previousCustomers.size,
    currentPeriodCustomers: currentCustomers.size,
    retainedCustomers: retained,
    churnedCustomers: churned,
  };
}

export interface RevenueTrendPoint {
  bucket: string;
  revenue: number;
  paymentCount: number;
  uniqueCustomers: number;
}

/** Revenue trend bucketed by day, month, or year, sorted ascending by bucket. */
export function buildRevenueTrend(rows: RevenueRow[], granularity: RevenueGranularity): RevenueTrendPoint[] {
  const buckets = new Map<string, { revenue: number; paymentCount: number; customers: Set<string> }>();

  for (const row of rows) {
    const date = toDate(row);
    if (Number.isNaN(date.getTime())) continue;
    const key = formatRevenueBucket(date, granularity);
    const entry = buckets.get(key) ?? { revenue: 0, paymentCount: 0, customers: new Set<string>() };
    entry.revenue += Number(row.amount ?? 0);
    entry.paymentCount += 1;
    entry.customers.add(row.meterId);
    buckets.set(key, entry);
  }

  return [...buckets.entries()]
    .map(([bucket, v]) => ({
      bucket,
      revenue: v.revenue,
      paymentCount: v.paymentCount,
      uniqueCustomers: v.customers.size,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export interface AcquisitionPoint {
  bucket: string;
  newCustomers: number;
}

/**
 * Customer acquisition per bucket: counts a meter the bucket of its first
 * ever payment (across the full row history passed in, not just a windowed
 * subset — pass the complete history so "first payment" is accurate).
 */
export function calculateCustomerAcquisition(
  rows: RevenueRow[],
  granularity: RevenueGranularity,
): AcquisitionPoint[] {
  const firstPaymentAt = new Map<string, Date>();
  for (const row of rows) {
    const date = toDate(row);
    if (Number.isNaN(date.getTime())) continue;
    const existing = firstPaymentAt.get(row.meterId);
    if (!existing || date.getTime() < existing.getTime()) {
      firstPaymentAt.set(row.meterId, date);
    }
  }

  const buckets = new Map<string, number>();
  for (const date of firstPaymentAt.values()) {
    const key = formatRevenueBucket(date, granularity);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .map(([bucket, newCustomers]) => ({ bucket, newCustomers }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export interface GeoRevenuePoint {
  region: string;
  revenue: number;
  paymentCount: number;
  customers: number;
  percentageOfTotal: number;
}

/**
 * Revenue grouped by region. "Region" is whatever free-text location string
 * is indexed for the meter (see lib/meterMetadataIndex.ts, the same source
 * routes/meterMap.ts uses) — meters with no indexed location fall into the
 * "Unknown" bucket. Sorted by revenue, descending.
 */
export function calculateGeoBreakdown(rows: RevenueRow[]): GeoRevenuePoint[] {
  const total = calculateTotalRevenue(rows);
  const groups = new Map<string, { revenue: number; paymentCount: number; customers: Set<string> }>();

  for (const row of rows) {
    const region = row.region && row.region.trim().length > 0 ? row.region.trim() : "Unknown";
    const entry = groups.get(region) ?? { revenue: 0, paymentCount: 0, customers: new Set<string>() };
    entry.revenue += Number(row.amount ?? 0);
    entry.paymentCount += 1;
    entry.customers.add(row.meterId);
    groups.set(region, entry);
  }

  return [...groups.entries()]
    .map(([region, v]) => ({
      region,
      revenue: v.revenue,
      paymentCount: v.paymentCount,
      customers: v.customers.size,
      percentageOfTotal: total === 0 ? 0 : (v.revenue / total) * 100,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

export interface RevenueAnalyticsSummary {
  range: { from: string; to: string; granularity: RevenueGranularity };
  totalRevenue: number;
  totalRevenueXlm: number;
  mrr: number;
  mrrXlm: number;
  arpu: number;
  arpuXlm: number;
  totalPayments: number;
  activeCustomers: number;
  churn: ChurnResult;
  trend: RevenueTrendPoint[];
  acquisition: AcquisitionPoint[];
  geoBreakdown: GeoRevenuePoint[];
}

/**
 * Build the full analytics summary for the GET /api/provider/analytics
 * response. `allRows` should be the full, unfiltered history (used for
 * accurate "first payment ever" acquisition calculations); `windowRows`
 * should already be filtered to [from, to).
 */
export function buildRevenueAnalyticsSummary(
  allRows: RevenueRow[],
  windowRows: RevenueRow[],
  from: Date,
  to: Date,
  granularity: RevenueGranularity,
): RevenueAnalyticsSummary {
  const churn = calculateChurnRate(allRows, from, to);
  const acquisitionAll = calculateCustomerAcquisition(allRows, granularity);
  const windowBuckets = new Set(buildRevenueTrend(windowRows, granularity).map((p) => p.bucket));
  const acquisition = acquisitionAll.filter((p) => windowBuckets.has(p.bucket));

  const totalRevenue = calculateTotalRevenue(windowRows);
  const mrr = calculateMRR(windowRows, to);
  const arpu = calculateARPU(windowRows);

  return {
    range: { from: from.toISOString(), to: to.toISOString(), granularity },
    totalRevenue,
    totalRevenueXlm: stroopsToXlm(totalRevenue),
    mrr,
    mrrXlm: stroopsToXlm(mrr),
    arpu,
    arpuXlm: stroopsToXlm(arpu),
    totalPayments: windowRows.length,
    activeCustomers: new Set(windowRows.map((r) => r.meterId)).size,
    churn,
    trend: buildRevenueTrend(windowRows, granularity),
    acquisition,
    geoBreakdown: calculateGeoBreakdown(windowRows),
  };
}
