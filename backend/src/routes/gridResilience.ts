/**
 * Grid resilience scoring (#941).
 *
 *   GET /api/grid/resilience                     live score, metrics, vulnerabilities, recommendations
 *   GET /api/grid/resilience/history?limit=      historical scores + trend
 */
import { Router } from "express";
import { getResilienceHistory, snapshotResilience } from "../lib/gridResilience.js";

export const gridResilienceRouter = Router();

gridResilienceRouter.get("/resilience", (_req, res) => {
  res.json(snapshotResilience());
});

gridResilienceRouter.get("/resilience/history", (req, res) => {
  const limit = Number(req.query.limit);
  res.json(getResilienceHistory(Number.isInteger(limit) && limit > 0 ? limit : undefined));
});
