import { Router } from "express";
import { backtest, strategies, type Tick } from "../algo/engine.js";

export const algosRouter = Router();

algosRouter.get("/strategies", (_req, res) => res.json(Object.keys(strategies)));

/** POST /api/algos/backtest { strategy, ticks: Tick[], startingCash? } */
algosRouter.post("/backtest", (req, res) => {
  const { strategy, ticks, startingCash } = req.body ?? {};
  const fn = strategies[strategy];
  if (!fn) return res.status(400).json({ error: "unknown strategy" });
  if (!Array.isArray(ticks) || ticks.length === 0) {
    return res.status(400).json({ error: "ticks must be a non-empty array" });
  }
  res.json(backtest(fn, ticks as Tick[], Number(startingCash ?? 1_000)).metrics);
});
