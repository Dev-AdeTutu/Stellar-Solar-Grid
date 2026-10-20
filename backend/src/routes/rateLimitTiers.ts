/**
 * Tiered rate limiting endpoints (#1080). See API.md.
 *
 *   GET /api/rate-limits/tiers              — tier definitions
 *   GET /api/rate-limits/usage              — real-time usage for the calling consumer
 *   PUT /api/rate-limits/subscriptions/:id  — admin: set a consumer's tier
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { consumerIdOf } from "../middleware/tieredRateLimit.js";
import { TIERS, getUsage, isTier, setTier } from "../lib/tieredRateLimit.js";

export const rateLimitTiersRouter = Router();

rateLimitTiersRouter.get("/tiers", (_req, res) => res.json({ tiers: TIERS }));

rateLimitTiersRouter.get("/usage", (req, res) => res.json(getUsage(consumerIdOf(req))));

rateLimitTiersRouter.put("/subscriptions/:consumerId", requireAdminKey, (req, res) => {
  const { tier } = req.body ?? {};
  if (!isTier(tier)) return res.status(400).json({ error: `tier must be one of ${Object.keys(TIERS).join(", ")}` });
  setTier(req.params.consumerId, tier);
  res.json(getUsage(req.params.consumerId));
});
