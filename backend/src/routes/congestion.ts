/**
 * Grid congestion pricing (#937).
 *
 *   GET    /api/congestion                        — current state for all zones
 *   GET    /api/congestion/:zone                  — state + adjusted price (?basePrice=)
 *   GET    /api/congestion/:zone/forecast         — 4-hour congestion forecast
 *   POST   /api/congestion/:zone/subscribe        — { ownerAddress } price-change push notifications
 *   DELETE /api/congestion/:zone/subscribe/:ownerAddress
 * Admin (X-Admin-Key):
 *   PUT    /api/congestion/:zone/capacity         — { capacity }
 *   POST   /api/congestion/:zone/load             — { load } real-time reading
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  adjustedPrice,
  forecastZone,
  getZoneState,
  listZoneStates,
  recordLoad,
  setZoneCapacity,
  subscribeToZone,
  unsubscribeFromZone,
} from "../lib/congestionPricing.js";

export const congestionRouter = Router();

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

congestionRouter.get("/", (_req, res) => {
  res.json({ zones: listZoneStates() });
});

congestionRouter.get("/:zone", (req, res) => {
  const state = getZoneState(req.params.zone);
  if (!state) return res.status(404).json({ error: "Zone not found" });
  const base = Number(req.query.basePrice);
  res.json({ ...state, ...(isPositive(base) ? { basePrice: base, adjustedPrice: adjustedPrice(state.zone, base) } : {}) });
});

congestionRouter.get("/:zone/forecast", (req, res) => {
  res.json({ zone: req.params.zone, horizonHours: 4, forecast: forecastZone(req.params.zone) });
});

congestionRouter.put("/:zone/capacity", requireAdminKey, (req, res) => {
  const { capacity } = req.body ?? {};
  if (!isPositive(capacity)) return res.status(400).json({ error: "capacity must be a positive number" });
  setZoneCapacity(req.params.zone, capacity);
  res.json({ zone: req.params.zone, capacity });
});

congestionRouter.post("/:zone/load", requireAdminKey, (req, res) => {
  const { load } = req.body ?? {};
  if (typeof load !== "number" || !Number.isFinite(load) || load < 0) {
    return res.status(400).json({ error: "load must be a non-negative number" });
  }
  try {
    res.status(201).json(recordLoad(req.params.zone, load));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

congestionRouter.post("/:zone/subscribe", (req, res) => {
  const { ownerAddress } = req.body ?? {};
  if (typeof ownerAddress !== "string" || !STELLAR_ADDRESS_RE.test(ownerAddress)) {
    return res.status(400).json({ error: "Invalid ownerAddress" });
  }
  subscribeToZone(req.params.zone, ownerAddress);
  res.status(201).json({ subscribed: true });
});

congestionRouter.delete("/:zone/subscribe/:ownerAddress", (req, res) => {
  unsubscribeFromZone(req.params.zone, req.params.ownerAddress);
  res.status(204).end();
});
