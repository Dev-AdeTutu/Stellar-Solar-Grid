/**
 * Grid resilience scoring (#941).
 *
 *   GET /api/grid/resilience                     live score, metrics, vulnerabilities, recommendations
 *   GET /api/grid/resilience/history?limit=      historical scores + trend
 *
 * Micro-grid island mode (#1041).
 *
 *   GET  /api/grid/island/status                 current island state + summary
 *   POST /api/grid/island/enter                  force entry into island mode
 *   POST /api/grid/island/exit                   force exit / resync with main grid
 *   GET  /api/grid/island/members                meters participating in the island
 */
import { Router } from "express";
import { getResilienceHistory, snapshotResilience } from "../lib/gridResilience.js";
import {
  enterIslandMode,
  exitIslandMode,
  getIslandMembers,
  getIslandStatus,
} from "../lib/islandMode.js";

export const gridResilienceRouter = Router();

gridResilienceRouter.get("/resilience", (_req, res) => {
  res.json(snapshotResilience());
});

gridResilienceRouter.get("/resilience/history", (req, res) => {
  const limit = Number(req.query.limit);
  res.json(getResilienceHistory(Number.isInteger(limit) && limit > 0 ? limit : undefined));
});

gridResilienceRouter.get("/island/status", (_req, res) => {
  res.json(getIslandStatus());
});

gridResilienceRouter.post("/island/enter", (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  res.json(enterIslandMode(reason));
});

gridResilienceRouter.post("/island/exit", (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  res.json(exitIslandMode(reason));
});

gridResilienceRouter.get("/island/members", (_req, res) => {
  res.json(getIslandMembers());
});