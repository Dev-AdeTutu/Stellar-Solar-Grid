/**
 * Meter health endpoints (#834).
 *
 *   GET  /api/meters/health                  — dashboard: every meter + status summary
 *   GET  /api/meters/:meterId/health         — health of one meter
 *   POST /api/meters/:meterId/heartbeat      — HTTP heartbeat (alternative to MQTT)
 */
import { Router } from "express";
import { getAllMeterHealth, getMeterHealth, recordHeartbeat } from "../lib/meterHealth.js";

export const meterHealthRouter = Router();

meterHealthRouter.get("/health", (_req, res) => {
  res.json(getAllMeterHealth());
});

meterHealthRouter.get("/:meterId/health", (req, res) => {
  const health = getMeterHealth(req.params.meterId);
  if (!health) {
    return res.status(404).json({ error: "No heartbeat recorded for this meter" });
  }
  res.json(health);
});

meterHealthRouter.post("/:meterId/heartbeat", (req, res) => {
  const { responseTimeMs, error } = req.body ?? {};
  recordHeartbeat(req.params.meterId, {
    responseTimeMs: typeof responseTimeMs === "number" ? responseTimeMs : undefined,
    error: error === true,
  });
  res.status(202).json(getMeterHealth(req.params.meterId));
});
