/**
 * Meter lifespan & depreciation endpoints (#998).
 *
 *   POST /api/meters/:meterId/asset-info       — register/update installation date, lifespan, purchase cost
 *   GET  /api/meters/:meterId/asset-info       — depreciation data for one meter
 *   GET  /api/meters/asset-info/report         — provider-wide depreciation report (X-Admin-Key)
 */
import { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { getAssetInfo, getAssetReport, registerMeterAsset } from "../lib/meterDepreciation.js";

export const meterDepreciationRouter = Router();

// Registered before the "/:meterId/asset-info" routes so "asset-info" isn't parsed as a meterId.
meterDepreciationRouter.get("/asset-info/report", requireAdminKey, (_req, res) => {
  res.json(getAssetReport());
});

const registerSchema = z.object({
  installedAt: z.string().datetime().optional(),
  expectedLifespanYears: z.number().positive().max(100).optional(),
  purchaseCostStroops: z.number().int().nonnegative().nullable().optional(),
});

meterDepreciationRouter.post("/:meterId/asset-info", (req, res) => {
  const parsed = registerSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid asset-info payload", details: parsed.error.issues });
  res.status(201).json(registerMeterAsset({ meterId: req.params.meterId, ...parsed.data }));
});

meterDepreciationRouter.get("/:meterId/asset-info", (req, res) => {
  const info = getAssetInfo(req.params.meterId);
  if (!info) return res.status(404).json({ error: "No asset info recorded for this meter" });
  res.json(info);
});
