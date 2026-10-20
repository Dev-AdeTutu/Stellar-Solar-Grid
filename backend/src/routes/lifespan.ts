/**
 * Meter lifespan extension recommendations (#1079). See backend/LIFESPAN.md.
 *
 *   GET  /api/lifespan/:meterId                 — analysis, ranked recommendations, ROI, lifespan status
 *   POST /api/lifespan/:meterId/failures        — record a failure event
 *   POST /api/lifespan/:meterId/maintenance     — record a completed maintenance action
 *   PUT  /api/lifespan/:meterId/install-date    — set the meter install date
 */
import { Router } from "express";
import {
  ACTION_CATALOG,
  analyzeFailures,
  lifespanStatus,
  maintenanceVsReplacement,
  recommend,
  recordFailure,
  recordMaintenance,
  setInstallDate,
  type FailureCause,
} from "../lib/lifespan.js";

const CAUSES = new Set<FailureCause>(["overheating", "moisture", "power_surge", "relay_wear", "firmware", "connectivity", "other"]);

export const lifespanRouter = Router();

lifespanRouter.get("/actions", (_req, res) => res.json({ actions: ACTION_CATALOG }));

lifespanRouter.get("/:meterId", (req, res) => {
  const { meterId } = req.params;
  res.json({
    meterId,
    failures: analyzeFailures(meterId),
    recommendations: recommend(meterId),
    costBenefit: maintenanceVsReplacement(meterId),
    lifespan: lifespanStatus(meterId),
  });
});

lifespanRouter.post("/:meterId/failures", (req, res) => {
  const { cause, occurredAt = new Date().toISOString(), downtimeHours = 0, repairCost = 0 } = req.body ?? {};
  if (!CAUSES.has(cause)) return res.status(400).json({ error: `cause must be one of ${[...CAUSES].join(", ")}` });
  if (Number.isNaN(Date.parse(occurredAt))) return res.status(400).json({ error: "occurredAt must be an ISO date" });
  res.status(201).json(recordFailure({ meterId: req.params.meterId, cause, occurredAt, downtimeHours: Number(downtimeHours), repairCost: Number(repairCost) }));
});

lifespanRouter.post("/:meterId/maintenance", (req, res) => {
  const { actionId, completedAt } = req.body ?? {};
  try {
    res.status(201).json(recordMaintenance(req.params.meterId, actionId, completedAt));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

lifespanRouter.put("/:meterId/install-date", (req, res) => {
  const { installedAt } = req.body ?? {};
  if (!installedAt || Number.isNaN(Date.parse(installedAt))) return res.status(400).json({ error: "installedAt must be an ISO date" });
  setInstallDate(req.params.meterId, installedAt);
  res.json({ meterId: req.params.meterId, installedAt });
});
