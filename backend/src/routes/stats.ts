import { Router } from "express";
import { getTopConsumers } from "../lib/usageEvents.js";

export const statsRouter = Router();

function requireAdminKey(req: any, res: any, next: any) {
  const adminKey = process.env.ADMIN_API_KEY;
  const provided = req.headers["x-admin-key"];
  if (!adminKey || provided !== adminKey) {
    return res.status(401).json({ error: "Valid admin key required" });
  }
  return next();
}

/**
 * GET /api/stats/top-consumers?days=30
 *
 * Returns the top 10 meters ranked by total units used over the given
 * window (default 30 days). Requires the X-Admin-Key header.
 */
statsRouter.get("/top-consumers", requireAdminKey, (req, res) => {
  const days = Math.max(1, Number(req.query.days ?? 30) || 30);
  const consumers = getTopConsumers(days, 10);
  res.json(consumers);
});
