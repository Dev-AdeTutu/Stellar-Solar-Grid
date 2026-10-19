/**
 * Energy portfolio management API (#926).
 *
 *   GET  /api/portfolio/:ownerId                 — dashboard (composition,
 *                                                  performance, risk, advice)
 *   GET  /api/portfolio/:ownerId/assets          — holdings
 *   POST /api/portfolio/:ownerId/assets          — add an asset
 *   DELETE /api/portfolio/:ownerId/assets/:id    — remove an asset
 *   POST /api/portfolio/:ownerId/assets/:id/delivery — record a delivery reading
 *   GET  /api/portfolio/:ownerId/performance     — ROI, efficiency, uptime
 *   GET  /api/portfolio/:ownerId/risk            — risk score and factors
 *   GET  /api/portfolio/:ownerId/allocation      — allocation recommendation
 *   GET  /api/portfolio/:ownerId/rebalance       — rebalancing plan
 *   POST /api/portfolio/:ownerId/rebalance       — apply the plan (one click)
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  addAsset,
  applyRebalance,
  assessRisk,
  getAsset,
  getDashboard,
  getPerformance,
  getRebalancePlan,
  listAssets,
  recordDelivery,
  recommendAllocation,
  removeAsset,
  type AssetType,
} from "../lib/portfolio.js";

export const portfolioRouter = Router();

const OwnerId = z.string().min(1).max(128);
const AssetId = z.string().min(1).max(128);
const AssetTypes = ["solar", "wind", "storage", "hydro", "grid"] as const;

const AddAssetBody = z.object({
  type: z.enum(AssetTypes),
  name: z.string().min(1).max(128),
  capacityKw: z.number().positive(),
  costBasisXlm: z.number().min(0).optional(),
  energyKwh: z.number().min(0).optional(),
  availableHours: z.number().min(0).optional(),
});

const DeliveryBody = z.object({ energyKwh: z.number().min(0) });

const RebalanceQuery = z.object({
  targetRiskScore: z.coerce.number().int().min(0).max(100).optional(),
});

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR", details: error.flatten() });
}

function domainError(res: Response, err: unknown) {
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : "Request failed";
  if (code === "NOT_FOUND") return res.status(404).json({ error: message });
  if (code === "FORBIDDEN") return res.status(403).json({ error: message });
  if (code === "CONFLICT") return res.status(409).json({ error: message });
  return res.status(400).json({ error: message, code });
}

portfolioRouter.get(
  "/:ownerId",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    res.json(getDashboard(owner.data));
  }),
);

portfolioRouter.get(
  "/:ownerId/assets",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    const assets = listAssets(owner.data);
    res.json({ assets, count: assets.length });
  }),
);

portfolioRouter.post(
  "/:ownerId/assets",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    const body = AddAssetBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(addAsset({ ...body.data, ownerId: owner.data, type: body.data.type as AssetType }));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

portfolioRouter.post(
  "/:ownerId/assets/:assetId/delivery",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    const asset = AssetId.safeParse(req.params.assetId);
    if (!owner.success || !asset.success) return res.status(400).json({ error: "ownerId and assetId are required" });
    const body = DeliveryBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    const held = getAsset(asset.data);
    if (!held) return res.status(404).json({ error: "Asset not found" });
    if (held.ownerId !== owner.data) return res.status(403).json({ error: "Not the asset owner" });
    try {
      res.json(recordDelivery(asset.data, body.data.energyKwh));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

portfolioRouter.delete(
  "/:ownerId/assets/:assetId",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    const asset = AssetId.safeParse(req.params.assetId);
    if (!owner.success || !asset.success) return res.status(400).json({ error: "ownerId and assetId are required" });
    try {
      res.json(removeAsset(asset.data, owner.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

portfolioRouter.get(
  "/:ownerId/performance",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    res.json(getPerformance(owner.data));
  }),
);

portfolioRouter.get(
  "/:ownerId/risk",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    res.json(assessRisk(owner.data));
  }),
);

portfolioRouter.get(
  "/:ownerId/allocation",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    const query = RebalanceQuery.safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    res.json(recommendAllocation(owner.data, query.data));
  }),
);

portfolioRouter.get(
  "/:ownerId/rebalance",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    const query = RebalanceQuery.safeParse(req.query);
    if (!query.success) return validationError(res, query.error);
    res.json(getRebalancePlan(owner.data, query.data));
  }),
);

portfolioRouter.post(
  "/:ownerId/rebalance",
  asyncHandler(async (req: Request, res: Response) => {
    const owner = OwnerId.safeParse(req.params.ownerId);
    if (!owner.success) return res.status(400).json({ error: "ownerId is required" });
    const query = RebalanceQuery.safeParse(req.body ?? {});
    if (!query.success) return validationError(res, query.error);
    res.json(applyRebalance(owner.data, query.data));
  }),
);
