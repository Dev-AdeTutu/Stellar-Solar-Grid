import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { initUsageEventStore } from "../lib/usageEvents.js";
import {
  createBucketFormatter,
  resolveTimezone,
  type AnalyticsGranularity,
} from "../lib/analyticsTimezone.js";

export const analyticsRouter = Router();

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: unknown; expiresAt: number }>();

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizeGranularity(value: unknown): AnalyticsGranularity {
  const v = String(value ?? "daily").trim().toLowerCase();
  return v === "weekly" || v === "monthly" ? v : "daily";
}

const RENEWABLE_SOURCES = new Set(["solar", "wind", "hydro", "geothermal", "biomass"]);

function isRenewable(source: string): boolean {
  return RENEWABLE_SOURCES.has(source.trim().toLowerCase());
}

function computeRenewablePercentage(mix: Array<{ source: string; units: number }>): number {
  let total = 0;
  let renewable = 0;
  for (const entry of mix) {
    const units = Number(entry.units ?? 0);
    if (!Number.isFinite(units) || units <= 0) continue;
    total += units;
    if (isRenewable(entry.source)) {
      renewable += units;
    }
  }
  if (total <= 0) return 0;
  return (renewable / total) * 100;
}

function sumTopMeters(rows: Array<{ meter_id: string; units: number }>): Array<{ meterId: string; totalUnits: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.meter_id, (totals.get(row.meter_id) ?? 0) + Number(row.units ?? 0));
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([meterId, totalUnits]) => ({ meterId, totalUnits }));
}

analyticsRouter.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const endDate = parseDate(req.query.end_date, now);
    const startDate = parseDate(req.query.start_date, new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000));
    const granularity = normalizeGranularity(req.query.granularity);
    const meterId = typeof req.query.meter_id === "string" ? req.query.meter_id.trim() : undefined;
    const timezone = resolveTimezone(req.query.timezone);
    if (timezone === null) {
      return res.status(400).json({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: { query: { timezone: ["Invalid IANA timezone"] } },
      });
    }

    // One formatter per request, not one per row. Buckets are derived in the
    // requested timezone so late-evening events stay on their local calendar day.
    const formatBucket = createBucketFormatter(timezone);

    const cacheKey = JSON.stringify({ startDate: startDate.toISOString(), endDate: endDate.toISOString(), granularity, meterId, timezone });
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.data);
      return;
    }

    const db = initUsageEventStore();
    const rows = db
      .prepare(
        `
          SELECT meter_id, units, received_at
          FROM usage_events
          WHERE received_at >= ? AND received_at <= ?
          ${meterId ? "AND meter_id = ?" : ""}
          ORDER BY received_at ASC
        `,
      )
      .all(
        startDate.toISOString(),
        endDate.toISOString(),
        ...(meterId ? [meterId] : []),
      ) as Array<{ meter_id: string; units: number; received_at: string }>;

    const bucketTotals = new Map<string, number>();
    const rowsPerBucket = new Map<string, number>();
    const meterTotals = new Map<string, number>();
    let peakBucket = "";
    let peakValue = 0;

    for (const row of rows) {
      const receivedAt = new Date(row.received_at);
      if (Number.isNaN(receivedAt.getTime())) continue;
      const bucket = formatBucket(receivedAt, granularity);
      const units = Number(row.units ?? 0);
      bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + units);
      rowsPerBucket.set(bucket, (rowsPerBucket.get(bucket) ?? 0) + 1);
      meterTotals.set(row.meter_id, (meterTotals.get(row.meter_id) ?? 0) + units);
      if ((bucketTotals.get(bucket) ?? 0) > peakValue) {
        peakBucket = bucket;
        peakValue = bucketTotals.get(bucket) ?? 0;
      }
    }

    const series = [...bucketTotals.entries()].map(([bucket, total]) => ({
      bucket,
      totalUnits: total,
      averageUsage: total / Math.max(1, rowsPerBucket.get(bucket) ?? 0),
    })).sort((a, b) => a.bucket.localeCompare(b.bucket));

    const summary = {
      totalUsage: [...meterTotals.values()].reduce((sum, value) => sum + value, 0),
      averageUsage: rows.length > 0 ? [...meterTotals.values()].reduce((sum, value) => sum + value, 0) / meterTotals.size || 0 : 0,
      activeMeters: meterTotals.size,
      peakBucket,
      peakUsage: peakValue,
      granularity,
      timezone,
    };

    const payload = {
      summary,
      series,
      topMeters: sumTopMeters(rows),
    };

    cache.set(cacheKey, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(payload);
  }),
);

analyticsRouter.get(
  "/energy-mix",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const endDate = parseDate(req.query.end_date, now);
    const startDate = parseDate(req.query.start_date, new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000));

    const cacheKey = JSON.stringify({ route: "energy-mix", startDate: startDate.toISOString(), endDate: endDate.toISOString() });
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.data);
      return;
    }

    const db = initUsageEventStore();
    const rows = db
      .prepare(
        `
          SELECT source, units
          FROM usage_events
          WHERE received_at >= ? AND received_at <= ?
        `,
      )
      .all(startDate.toISOString(), endDate.toISOString()) as Array<{ source: string; units: number }>;

    const totals = new Map<string, number>();
    for (const row of rows) {
      const source = String(row.source ?? "unknown").trim().toLowerCase() || "unknown";
      const units = Number(row.units ?? 0);
      if (!Number.isFinite(units) || units <= 0) continue;
      totals.set(source, (totals.get(source) ?? 0) + units);
    }

    const mix = [...totals.entries()]
      .map(([source, units]) => ({ source, units }))
      .sort((a, b) => b.units - a.units);

    const payload = {
      mix,
      renewablePercentage: computeRenewablePercentage(mix),
    };

    cache.set(cacheKey, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(payload);
  }),
);
