/**
 * Virtual Power Plant aggregation API (#925).
 *
 *   GET  /api/vpp                      — all VPPs
 *   POST /api/vpp                      — create a VPP
 *   GET  /api/vpp/services             — grid services and their open windows
 *   GET  /api/vpp/:vppId               — one VPP with its resources
 *   GET  /api/vpp/:vppId/resources     — aggregated fleet
 *   POST /api/vpp/:vppId/resources     — join / enroll a resource
 *   DELETE /api/vpp/:vppId/resources/:resourceId — withdraw a resource
 *   PATCH /api/vpp/:vppId/resources/:resourceId — update availability
 *   GET  /api/vpp/:vppId/capacity      — aggregated vs available capacity
 *   GET  /api/vpp/:vppId/bids          — grid-service bids
 *   POST /api/vpp/:vppId/bids          — bid into a grid service
 *   POST /api/vpp/bids/:bidId/withdraw — withdraw an open bid
 *   POST /api/vpp/bids/:bidId/settle   — settle and distribute revenue
 *   GET  /api/vpp/:vppId/settlements   — revenue distributions
 *   GET  /api/vpp/:vppId/performance   — real-time performance
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  GRID_SERVICES,
  aggregateCapacityKw,
  availableCapacityKw,
  committedCapacityKw,
  createVpp,
  getPerformance,
  getResource,
  getVpp,
  isServiceOpen,
  joinVpp,
  leaveVpp,
  listBids,
  listOpenServices,
  listResources,
  listSettlements,
  listVpps,
  settleBid,
  submitBid,
  updateResourceAvailability,
  withdrawBid,
  type GridService,
  type ResourceType,
} from "../lib/vpp.js";

export const vppRouter = Router();

const VppId = z.string().min(1).max(128);
const ResourceId = z.string().min(1).max(128);
const GridServices = [...GRID_SERVICES] as [GridService, ...GridService[]];
const ResourceTypes = ["solar", "battery", "ev", "load", "wind"] as const;

const CreateVppBody = z.object({
  name: z.string().min(1).max(128),
  service: z.enum(GridServices),
  operatorId: z.string().min(1),
  availabilityFactor: z.number().gt(0).max(1).optional(),
  diversityFactor: z.number().gt(0).max(1).optional(),
});

const JoinBody = z.object({
  ownerId: z.string().min(1),
  name: z.string().min(1).max(128),
  type: z.enum(ResourceTypes),
  capacityKw: z.number().positive(),
  energyKwh: z.number().min(0).optional(),
  uptime: z.number().min(0).max(1).optional(),
});

const AvailabilityBody = z.object({
  availableKw: z.number().min(0).optional(),
  status: z.enum(["online", "offline", "maintenance"]).optional(),
  energyKwh: z.number().min(0).optional(),
  uptime: z.number().min(0).max(1).optional(),
});

const BidBody = z.object({
  energyKwh: z.number().positive(),
  priceXlmPerKwh: z.number().positive(),
  deliveryHour: z.number().int().min(0).max(23).optional(),
});

const SettleBody = z.object({
  deliveredKwhByResource: z.record(z.string(), z.number().min(0)),
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

vppRouter.get(
  "/services",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      services: GRID_SERVICES.map((service) => ({ service, open: isServiceOpen(service) })),
      open: listOpenServices(),
    });
  }),
);

vppRouter.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const vpps = listVpps();
    res.json({ vpps, count: vpps.length });
  }),
);

vppRouter.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const body = CreateVppBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(createVpp(body.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.post(
  "/bids/:bidId/withdraw",
  asyncHandler(async (req: Request, res: Response) => {
    const bid = z.string().min(1).safeParse(req.params.bidId);
    if (!bid.success) return res.status(400).json({ error: "bidId is required" });
    try {
      res.json(withdrawBid(bid.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.post(
  "/bids/:bidId/settle",
  asyncHandler(async (req: Request, res: Response) => {
    const bid = z.string().min(1).safeParse(req.params.bidId);
    if (!bid.success) return res.status(400).json({ error: "bidId is required" });
    const body = SettleBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.json(settleBid({ bidId: bid.data, deliveredKwhByResource: body.data.deliveredKwhByResource }));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.get(
  "/:vppId",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    const vpp = getVpp(id.data);
    if (!vpp) return res.status(404).json({ error: "VPP not found" });
    res.json({ ...vpp, resources: listResources(vpp.id) });
  }),
);

vppRouter.get(
  "/:vppId/resources",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    if (!getVpp(id.data)) return res.status(404).json({ error: "VPP not found" });
    const resources = listResources(id.data);
    res.json({
      resources,
      count: resources.length,
      nameplateCapacityKw: resources.reduce((sum, r) => sum + r.capacityKw, 0),
      aggregateCapacityKw: aggregateCapacityKw(id.data),
      availableCapacityKw: availableCapacityKw(id.data),
    });
  }),
);

vppRouter.post(
  "/:vppId/resources",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    const body = JoinBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(joinVpp({ ...body.data, vppId: id.data, type: body.data.type as ResourceType }));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.patch(
  "/:vppId/resources/:resourceId",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    const resource = ResourceId.safeParse(req.params.resourceId);
    if (!id.success || !resource.success) return res.status(400).json({ error: "vppId and resourceId are required" });
    const body = AvailabilityBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    const held = getResource(resource.data);
    if (!held) return res.status(404).json({ error: "Resource not found" });
    if (held.vppId !== id.data) return res.status(400).json({ error: "Resource does not belong to this VPP" });
    try {
      res.json(updateResourceAvailability(resource.data, body.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.delete(
  "/:vppId/resources/:resourceId",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    const resource = ResourceId.safeParse(req.params.resourceId);
    if (!id.success || !resource.success) return res.status(400).json({ error: "vppId and resourceId are required" });
    try {
      res.json(leaveVpp(id.data, resource.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.get(
  "/:vppId/capacity",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    if (!getVpp(id.data)) return res.status(404).json({ error: "VPP not found" });
    const aggregate = aggregateCapacityKw(id.data);
    const available = availableCapacityKw(id.data);
    const committed = committedCapacityKw(id.data);
    res.json({
      vppId: id.data,
      nameplateCapacityKw: listResources(id.data).reduce((sum, r) => sum + r.capacityKw, 0),
      aggregateCapacityKw: aggregate,
      availableCapacityKw: available,
      committedCapacityKw: committed,
      freeCapacityKw: Math.max(0, available - committed),
    });
  }),
);

vppRouter.get(
  "/:vppId/bids",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    if (!getVpp(id.data)) return res.status(404).json({ error: "VPP not found" });
    const bids = listBids(id.data);
    res.json({ bids, count: bids.length, open: listBids(id.data, "open").length });
  }),
);

vppRouter.post(
  "/:vppId/bids",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    const body = BidBody.safeParse(req.body);
    if (!body.success) return validationError(res, body.error);
    try {
      res.status(201).json(submitBid({ ...body.data, vppId: id.data }));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

vppRouter.get(
  "/:vppId/settlements",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    if (!getVpp(id.data)) return res.status(404).json({ error: "VPP not found" });
    const list = listSettlements(id.data);
    res.json({ settlements: list, count: list.length });
  }),
);

vppRouter.get(
  "/:vppId/performance",
  asyncHandler(async (req: Request, res: Response) => {
    const id = VppId.safeParse(req.params.vppId);
    if (!id.success) return res.status(400).json({ error: "vppId is required" });
    try {
      res.json(getPerformance(id.data));
    } catch (err) {
      return domainError(res, err);
    }
  }),
);

