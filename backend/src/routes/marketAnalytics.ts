/**
 * Energy trading analytics API (#873).
 *
 *   GET /api/analytics/market?range=7d|30d|90d&meter_id=
 *   GET /api/analytics/market/export?range=30d&format=csv|pdf&meter_id=
 *
 * Results are cached briefly per (range, meter) because every request
 * aggregates the whole window.
 */
import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  analyticsToCsv,
  analyticsToPdf,
  computeMarketAnalytics,
  isRange,
  type MarketAnalytics,
  type Range,
} from "../lib/marketAnalytics.js";

type Db = InstanceType<typeof Database>;

const CACHE_TTL_MS = Number(process.env.MARKET_ANALYTICS_CACHE_TTL_MS ?? 60_000);
const MAX_CACHE_ENTRIES = 200;

function parseQuery(req: Request, res: Response): { range: Range; meterId: string | null } | null {
  const range = req.query.range ?? "30d";
  if (!isRange(range)) {
    res.status(400).json({ error: "range must be one of 7d, 30d, 90d", code: "VALIDATION_ERROR" });
    return null;
  }
  const meterId = typeof req.query.meter_id === "string" && req.query.meter_id.trim() ? req.query.meter_id.trim() : null;
  if (meterId && meterId.length > 64) {
    res.status(400).json({ error: "meter_id is too long", code: "VALIDATION_ERROR" });
    return null;
  }
  return { range, meterId };
}

export function createMarketAnalyticsRouter(getDb: () => Db): Router {
  const router = Router();
  const cache = new Map<string, { value: MarketAnalytics; expiresAt: number }>();

  function load(range: Range, meterId: string | null): MarketAnalytics {
    const key = `${range}:${meterId ?? ""}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = computeMarketAnalytics(getDb(), { range, meterId });
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = parseQuery(req, res);
      if (!q) return;
      res.setHeader("Cache-Control", `private, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
      res.json(load(q.range, q.meterId));
    }),
  );

  router.get(
    "/export",
    asyncHandler(async (req, res) => {
      const q = parseQuery(req, res);
      if (!q) return;
      const format = String(req.query.format ?? "csv");
      if (format !== "csv" && format !== "pdf") {
        return res.status(400).json({ error: "format must be csv or pdf", code: "VALIDATION_ERROR" });
      }
      const analytics = load(q.range, q.meterId);
      const name = `energy-trading-${q.range}${q.meterId ? `-${q.meterId.replace(/[^\w-]/g, "_")}` : ""}-${analytics.to.slice(0, 10)}`;
      if (format === "csv") {
        res.type("text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=${name}.csv`);
        return res.send(analyticsToCsv(analytics));
      }
      res.type("application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${name}.pdf`);
      return res.send(analyticsToPdf(analytics));
    }),
  );

  return router;
}
