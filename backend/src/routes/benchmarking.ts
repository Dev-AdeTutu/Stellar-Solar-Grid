import { Router } from "express";
import { detectOutliers, improvement, recordFix, MeterProfile } from "../lib/benchmarking.js";

export const benchmarkingRouter = Router();

/** POST /api/benchmarking/analyze  body: { meters: MeterProfile[], threshold? } */
benchmarkingRouter.post("/analyze", (req, res) => {
  const { meters, threshold } = req.body as { meters: MeterProfile[]; threshold?: number };
  if (!Array.isArray(meters)) return res.status(400).json({ error: "meters array required" });
  res.json({ outliers: detectOutliers(meters, threshold) });
});

benchmarkingRouter.post("/fixes", (req, res) => {
  const { meterId, baselineRatio, action } = req.body;
  recordFix(meterId, Number(baselineRatio), action);
  res.status(201).json({ ok: true });
});

benchmarkingRouter.get("/fixes/:meterId", (req, res) => {
  const r = improvement(req.params.meterId, Number(req.query.currentRatio ?? 0));
  r ? res.json(r) : res.status(404).json({ error: "No fix recorded" });
});
