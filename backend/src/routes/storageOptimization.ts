/**
 * Energy storage optimization AI (#1053). See backend/AI_OPTIMIZATION.md.
 *
 *   POST /api/storage-optimization/plan  — train an RL agent on a day profile and return
 *                                          the control schedule plus savings vs baseline
 */
import { Router } from "express";
import { StorageAgent, DEFAULT_CONFIG, seededRandom, type Battery, type HourInput } from "../lib/storageOptimizer.js";

export const storageOptimizationRouter = Router();

storageOptimizationRouter.post("/plan", (req, res) => {
  const { battery, day, episodes = 500, seed = 42 } = req.body ?? {};
  const b = battery as Battery | undefined;
  if (!b || !(b.capacityKwh > 0) || !(b.maxRateKw > 0) || !(b.efficiency > 0 && b.efficiency <= 1) || !(b.socKwh >= 0 && b.socKwh <= b.capacityKwh)) {
    return res.status(400).json({ error: "battery requires capacityKwh>0, maxRateKw>0, 0<efficiency<=1, 0<=socKwh<=capacityKwh" });
  }
  if (!Array.isArray(day) || day.length === 0 || day.length > 168) return res.status(400).json({ error: "day must be an array of 1-168 hourly inputs" });
  const hours = day as HourInput[];
  if (hours.some((h) => ![h.hour, h.pricePerKwh, h.solarKwh, h.loadKwh].every((v) => typeof v === "number" && v >= 0))) {
    return res.status(400).json({ error: "each hour needs non-negative hour, pricePerKwh, solarKwh, loadKwh" });
  }
  const n = Math.min(5000, Math.max(1, Number(episodes) || 500));
  const agent = new StorageAgent(DEFAULT_CONFIG, seededRandom(Number(seed)));
  agent.train(hours, b, n);
  res.json({ episodes: n, ...agent.plan(hours, b) });
});
