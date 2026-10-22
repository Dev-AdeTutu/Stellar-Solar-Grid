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

// ---------------------------------------------------------------------------
// VPP performance & revenue tracking (#1044)
// ---------------------------------------------------------------------------

/**
 * A single dispatch event issued to a VPP portfolio by the grid operator.
 * `dispatchedKw` is the aggregate power requested across the fleet; the
 * per-meter contributions are recorded separately as VppDispatchAllocation
 * rows so revenue can be attributed back to individual participants.
 */
export interface VppDispatchEvent {
  id: string;
  vppId: string;
  /** Grid operator that issued the signal, e.g. "ERCOT" or "PJM". */
  operatorId: string;
  /** Operator signal type, e.g. "capacity", "frequency_response", "demand_response". */
  signalType: string;
  /** ISO-8601 timestamp the dispatch window opens. */
  startAt: string;
  /** ISO-8601 timestamp the dispatch window closes. */
  endAt: string;
  /** Aggregate power requested from the portfolio, in kW. */
  dispatchedKw: number;
  /** Aggregate power actually delivered by the fleet, in kW. */
  deliveredKw: number;
  /** Revenue earned from the operator for this event, in stroops. */
  revenue: number;
  /** ISO-8601 timestamp the event was recorded. */
  createdAt: string;
}

/** One participant meter's share of a VPP dispatch event. */
export interface VppDispatchAllocation {
  eventId: string;
  vppId: string;
  meterId: string;
  /** Power this meter was asked to contribute, in kW. */
  allocatedKw: number;
  /** Power this meter actually delivered, in kW. */
  deliveredKw: number;
  /** Participant's share of the event revenue, in stroops. */
  earnings: number;
}

export interface VppPerformanceSummary {
  vppId: string;
  eventCount: number;
  totalDispatchedKw: number;
  totalDeliveredKw: number;
  /** Delivered / dispatched, clamped to [0, 1]; 1 when nothing was dispatched. */
  deliveryRate: number;
  totalRevenue: number;
  totalRevenueXlm: number;
  participantCount: number;
}

export interface VppParticipantEarnings {
  meterId: string;
  eventCount: number;
  totalAllocatedKw: number;
  totalDeliveredKw: number;
  deliveryRate: number;
  earnings: number;
  earningsXlm: number;
  /** Participant's share of the portfolio's total earnings, as a percentage. */
  percentageOfTotal: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeNumber(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Split an event's revenue across its allocations proportionally to each
 * meter's delivered kW (falling back to allocated kW when nothing was
 * delivered). Returns allocations with `earnings` filled in; the sum of
 * earnings equals the event revenue exactly (rounding remainder is assigned
 * to the largest contributor).
 */
export function allocateDispatchRevenue(
  revenue: number,
  allocations: Array<Pick<VppDispatchAllocation, "meterId" | "allocatedKw" | "deliveredKw">>,
): VppDispatchAllocation[] {
  const total = safeNumber(revenue);
  if (allocations.length === 0) return [];

  const weights = allocations.map((a) => {
    const delivered = safeNumber(a.deliveredKw);
    return delivered > 0 ? delivered : safeNumber(a.allocatedKw);
  });
  const weightSum = weights.reduce((sum, w) => sum + w, 0);

  if (weightSum <= 0 || total === 0) {
    return allocations.map((a) => ({
      eventId: "",
      vppId: "",
      meterId: a.meterId,
      allocatedKw: safeNumber(a.allocatedKw),
      deliveredKw: safeNumber(a.deliveredKw),
      earnings: 0,
    }));
  }

  const raw = weights.map((w) => (w / weightSum) * total);
  const floored = raw.map((v) => Math.floor(v));
  let remainder = Math.round(total) - floored.reduce((sum, v) => sum + v, 0);

  // Distribute the rounding remainder to the largest fractional parts.
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const earnings = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    earnings[order[k].i] += 1;
    remainder -= 1;
  }

  return allocations.map((a, i) => ({
    eventId: "",
    vppId: "",
    meterId: a.meterId,
    allocatedKw: safeNumber(a.allocatedKw),
    deliveredKw: safeNumber(a.deliveredKw),
    earnings: earnings[i],
  }));
}

/** Aggregate performance metrics for a single VPP portfolio. */
export function calculateVppPerformance(
  vppId: string,
  events: VppDispatchEvent[],
  allocations: VppDispatchAllocation[] = [],
): VppPerformanceSummary {
  const scoped = events.filter((e) => e.vppId === vppId);
  const totalDispatchedKw = scoped.reduce((sum, e) => sum + safeNumber(e.dispatchedKw), 0);
  const totalDeliveredKw = scoped.reduce((sum, e) => sum + safeNumber(e.deliveredKw), 0);
  const totalRevenue = scoped.reduce((sum, e) => sum + safeNumber(e.revenue), 0);
  const participants = new Set(
    allocations.filter((a) => a.vppId === vppId).map((a) => a.meterId),
  );

  return {
    vppId,
    eventCount: scoped.length,
    totalDispatchedKw,
    totalDeliveredKw,
    deliveryRate:
      totalDispatchedKw <= 0 ? 1 : clamp01(totalDeliveredKw / totalDispatchedKw),
    totalRevenue,
    totalRevenueXlm: stroopsToXlm(totalRevenue),
    participantCount: participants.size,
  };
}

/**
 * Per-participant earnings for a VPP portfolio, sorted by earnings descending.
 * `percentageOfTotal` is each meter's share of the portfolio's total earnings.
 */
export function calculateVppParticipantEarnings(
  vppId: string,
  allocations: VppDispatchAllocation[],
): VppParticipantEarnings[] {
  const scoped = allocations.filter((a) => a.vppId === vppId);
  const groups = new Map<
    string,
    { eventIds: Set<string>; allocatedKw: number; deliveredKw: number; earnings: number }
  >();

  for (const a of scoped) {
    const entry =
      groups.get(a.meterId) ??
      { eventIds: new Set<string>(), allocatedKw: 0, deliveredKw: 0, earnings: 0 };
    entry.eventIds.add(a.eventId);
    entry.allocatedKw += safeNumber(a.allocatedKw);
    entry.deliveredKw += safeNumber(a.deliveredKw);
    entry.earnings += safeNumber(a.earnings);
    groups.set(a.meterId, entry);
  }

  const totalEarnings = [...groups.values()].reduce((sum, v) => sum + v.earnings, 0);

  return [...groups.entries()]
    .map(([meterId, v]) => ({
      meterId,
      eventCount: v.eventIds.size,
      totalAllocatedKw: v.allocatedKw,
      totalDeliveredKw: v.deliveredKw,
      deliveryRate: v.allocatedKw <= 0 ? 1 : clamp01(v.deliveredKw / v.allocatedKw),
      earnings: v.earnings,
      earningsXlm: stroopsToXlm(v.earnings),
      percentageOfTotal: totalEarnings === 0 ? 0 : (v.earnings / totalEarnings) * 100,
    }))
    .sort((a, b) => b.earnings - a.earnings);
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
