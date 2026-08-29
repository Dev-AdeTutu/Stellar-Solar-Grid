import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { initUsageEventStore } from "../lib/usageEvents.js";

export const analyticsRouter = Router();

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: unknown; expiresAt: number }>();

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizeGranularity(value: unknown): "daily" | "weekly" | "monthly" {
  const v = String(value ?? "daily").trim().toLowerCase();
  return v === "weekly" || v === "monthly" ? v : "daily";
}

function formatBucket(date: Date, granularity: "daily" | "weekly" | "monthly"): string {
  if (granularity === "daily") {
    return date.toISOString().slice(0, 10);
  }
  if (granularity === "weekly") {
    const start = new Date(date);
    const day = start.getUTCDay();
    const diff = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - diff);
    start.setUTCHours(0, 0, 0, 0);
    return start.toISOString().slice(0, 10);
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addBucket(map: Map<string, number>, date: Date, granularity: "daily" | "weekly" | "monthly", value: number) {
  const bucket = formatBucket(date, granularity);
  map.set(bucket, (map.get(bucket) ?? 0) + value);
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

    const cacheKey = JSON.stringify({ startDate: startDate.toISOString(), endDate: endDate.toISOString(), granularity, meterId });
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
    const meterTotals = new Map<string, number>();
    let peakBucket = "";
    let peakValue = 0;

    for (const row of rows) {
      const receivedAt = new Date(row.received_at);
      if (Number.isNaN(receivedAt.getTime())) continue;
      const bucket = formatBucket(receivedAt, granularity);
      const units = Number(row.units ?? 0);
      addBucket(bucketTotals, receivedAt, granularity, units);
      meterTotals.set(row.meter_id, (meterTotals.get(row.meter_id) ?? 0) + units);
      if ((bucketTotals.get(bucket) ?? 0) > peakValue) {
        peakBucket = bucket;
        peakValue = bucketTotals.get(bucket) ?? 0;
      }
    }

    const series = [...bucketTotals.entries()].map(([bucket, total]) => ({
      bucket,
      totalUnits: total,
      averageUsage: rows.length > 0 ? total / Math.max(1, rows.filter((row) => formatBucket(new Date(row.received_at), granularity) === bucket).length) : 0,
    })).sort((a, b) => a.bucket.localeCompare(b.bucket));

    const summary = {
      totalUsage: [...meterTotals.values()].reduce((sum, value) => sum + value, 0),
      averageUsage: rows.length > 0 ? [...meterTotals.values()].reduce((sum, value) => sum + value, 0) / meterTotals.size || 0 : 0,
      activeMeters: meterTotals.size,
      peakBucket,
      peakUsage: peakValue,
      granularity,
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
