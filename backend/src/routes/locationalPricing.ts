/**
 * Locational marginal pricing endpoints (#1057).
 *
 *   GET    /api/pricing/regions                      — current LMP for all regions
 *   GET    /api/pricing/heatmap                      — prices with 0..1 intensity for the map
 *   GET    /api/pricing/regions/:region
 *   POST   /api/pricing/regions/:region/subscribe    — { ownerAddress }
 *   DELETE /api/pricing/regions/:region/subscribe/:ownerAddress
 * Admin (X-Admin-Key):
 *   PUT    /api/pricing/regions/:region              — { zone, lossFactor, lat?, lng? }
 *   PUT    /api/pricing/base                         — { price }
 *   POST   /api/pricing/reprice                      — force recompute now
 */
import { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  getPrice,
  heatmap,
  listPrices,
  repriceAll,
  setBasePrice,
  subscribeToRegion,
  unsubscribeFromRegion,
  upsertRegion,
} from "../lib/locationalPricing.js";

export const locationalPricingRouter = Router();

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

locationalPricingRouter.get("/regions", (_req, res) => res.json(listPrices()));
locationalPricingRouter.get("/heatmap", (_req, res) => res.json(heatmap()));

locationalPricingRouter.get("/regions/:region", (req, res) => {
  const p = getPrice(req.params.region);
  if (!p) return res.status(404).json({ error: "Unknown region" });
  res.json(p);
});

locationalPricingRouter.put("/regions/:region", requireAdminKey, (req, res) => {
  const parsed = z.object({
    zone: z.string().min(1),
    lossFactor: z.number().min(0).max(1),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid region", details: parsed.error.issues });
  upsertRegion({ region: req.params.region, ...parsed.data });
  repriceAll();
  res.json(getPrice(req.params.region));
});

locationalPricingRouter.put("/base", requireAdminKey, (req, res) => {
  const parsed = z.object({ price: z.number().positive() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid base price" });
  setBasePrice(parsed.data.price);
  res.json(repriceAll());
});

locationalPricingRouter.post("/reprice", requireAdminKey, (_req, res) => res.json(repriceAll()));

locationalPricingRouter.post("/regions/:region/subscribe", (req, res) => {
  const owner = req.body?.ownerAddress;
  if (typeof owner !== "string" || !STELLAR_ADDRESS_RE.test(owner)) {
    return res.status(400).json({ error: "ownerAddress must be a Stellar address" });
  }
  subscribeToRegion(req.params.region, owner);
  res.status(201).json({ region: req.params.region, ownerAddress: owner });
});

locationalPricingRouter.delete("/regions/:region/subscribe/:ownerAddress", (req, res) => {
  unsubscribeFromRegion(req.params.region, req.params.ownerAddress);
  res.status(204).end();
});
