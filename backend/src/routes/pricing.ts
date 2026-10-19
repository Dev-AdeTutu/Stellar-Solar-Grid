/**
 * Dynamic pricing API (#877).
 *
 *   GET  /api/pricing/current           — current price point
 *   GET  /api/pricing/history           — recent price history (up to 96 intervals)
 *   GET  /api/pricing/predict           — price predictions for next N hours
 *   POST /api/pricing/tick              — manually trigger a price recalculation (admin)
 *   GET  /api/pricing/config            — current pricing config (admin)
 *   PUT  /api/pricing/config            — update pricing config (admin)
 *   GET  /api/pricing/season            — current season, multiplier and configured rates
 *   PUT  /api/pricing/season            — update seasonal rates (admin)
 *   GET  /api/pricing/season/history    — historical seasonal comparison
 */
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  getCurrentPrice,
  getPriceHistory,
  getPricingConfig,
  updatePricingConfig,
  calculatePrice,
  recordPrice,
  predictPrice,
  getSeasonalRates,
  setSeasonalRates,
  getCurrentSeason,
  SeasonalRate,
} from "../lib/dynamicPricing.js";

export const pricingRouter = Router();

pricingRouter.get(
  "/current",
  asyncHandler(async (_req: Request, res: Response) => {
    const price = getCurrentPrice();
    if (!price) {
      const point = calculatePrice(100, 100);
      recordPrice(point);
      return res.json(point);
    }
    res.json(price);
  }),
);

pricingRouter.get(
  "/history",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 96), 672);
    res.json({ history: getPriceHistory(limit) });
  }),
);

pricingRouter.get(
  "/predict",
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 168);
    const supply = Number(req.query.supply ?? 100);
    const demand = Number(req.query.demand ?? 100);
    if (!Number.isFinite(hours) || hours < 1) {
      return res.status(400).json({ error: "hours must be between 1 and 168" });
    }
    res.json({ predictions: predictPrice(hours, supply, demand) });
  }),
);

pricingRouter.post(
  "/tick",
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { supplyKwh = 100, demandKwh = 100 } = req.body as { supplyKwh?: number; demandKwh?: number };
    const point = calculatePrice(Number(supplyKwh), Number(demandKwh));
    recordPrice(point);
    res.json(point);
  }),
);

pricingRouter.get(
  "/config",
  requireAdminKey,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getPricingConfig());
  }),
);

pricingRouter.put(
  "/config",
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const allowed = ["basePrice", "peakMultiplier", "offPeakMultiplier", "maxPrice", "minPrice"];
    const update: Record<string, number> = {};
    for (const key of allowed) {
      if (key in body) {
        const v = Number(body[key]);
        if (!Number.isFinite(v) || v <= 0) {
          return res.status(400).json({ error: `${key} must be a positive number` });
        }
        update[key] = v;
      }
    }
    const updated = updatePricingConfig(update);
    res.json(updated);
  }),
);

pricingRouter.get(
  "/season",
  asyncHandler(async (_req: Request, res: Response) => {
    const rates = getSeasonalRates();
    const current = getCurrentSeason();
    res.json({
      season: current ? current.season : null,
      multiplier: current ? current.multiplier : 1,
      rates,
    });
  }),
);

pricingRouter.put(
  "/season",
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { rates?: unknown };
    if (!Array.isArray(body.rates)) {
      return res.status(400).json({ error: "rates must be an array of seasonal rates" });
    }
    const rates: SeasonalRate[] = [];
    for (const entry of body.rates) {
      const r = entry as Record<string, unknown>;
      const season = String(r.season ?? "").trim();
      const startDate = Number(r.startDate);
      const endDate = Number(r.endDate);
      const multiplier = Number(r.multiplier);
      if (!season) {
        return res.status(400).json({ error: "each rate requires a season name" });
      }
      if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
        return res.status(400).json({ error: `season ${season} requires numeric startDate and endDate` });
      }
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        return res.status(400).json({ error: `season ${season} multiplier must be a positive number` });
      }
      rates.push({ season, startDate, endDate, multiplier });
    }
    const updated = setSeasonalRates(rates);
    res.json({ rates: updated });
  }),
);

pricingRouter.get(
  "/season/history",
  asyncHandler(async (req: Request, res: Response) => {
    const years = Math.min(Math.max(Number(req.query.years ?? 1), 1), 10);
    const history = getPriceHistory(672);
    const cutoff = Date.now() - years * 365 * 24 * 60 * 60 * 1000;
    const buckets = new Map<string, { total: number; count: number }>();
    for (const point of history) {
      const ts = new Date(point.timestamp).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const season = getCurrentSeason(new Date(ts));
      const key = season ? season.season : "unknown";
      const bucket = buckets.get(key) ?? { total: 0, count: 0 };
      bucket.total += point.price;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
    const comparison = Array.from(buckets.entries()).map(([season, { total, count }]) => ({
      season,
      averagePrice: count > 0 ? total / count : 0,
      samples: count,
    }));
    res.json({ years, comparison });
  }),
);
