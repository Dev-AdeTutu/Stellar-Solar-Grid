/**
 * Dynamic pricing API (#877).
 *
 *   GET  /api/pricing/current           — current price point
 *   GET  /api/pricing/history           — recent price history (up to 96 intervals)
 *   GET  /api/pricing/predict           — price predictions for next N hours
 *   POST /api/pricing/tick              — manually trigger a price recalculation (admin)
 *   GET  /api/pricing/config            — current pricing config (admin)
 *   PUT  /api/pricing/config            — update pricing config (admin)
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
