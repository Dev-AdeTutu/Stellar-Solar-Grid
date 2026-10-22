/**
 * P2P energy trading market analytics endpoint (#999).
 *
 *   GET /api/market/analytics — current market snapshot: avg price, volume,
 *     liquidity, supply/demand and hourly/daily/weekly price history.
 */
import { Router } from "express";
import { computeTradeAnalytics } from "../lib/marketTradeAnalytics.js";

export const marketTradeAnalyticsRouter = Router();

marketTradeAnalyticsRouter.get("/", (_req, res) => {
  res.json(computeTradeAnalytics());
});
