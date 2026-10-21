/**
 * Emergency energy sharing (#893)
 *
 * During outages an admin activates emergency mode. Community members donate
 * kWh into a shared pool, and the pool is routed to registered facilities by
 * priority (hospitals first, then shelters, water, etc.). Critical facilities
 * receive energy free of charge; others at a subsidised rate.
 *
 * POST /api/emergency/activate     (admin) { reason }
 * POST /api/emergency/deactivate   (admin)
 * POST /api/emergency/facilities   (admin) { meterId, name, type, demandKwh }
 * POST /api/emergency/donations    { donorMeterId, kwh }
 * POST /api/emergency/route        (admin) — run the priority routing pass
 * GET  /api/emergency              — dashboard snapshot
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";

export const emergencyRouter = Router();

export type FacilityType = "hospital" | "clinic" | "shelter" | "water" | "school" | "household";

/** Lower = served first. */
export const FACILITY_PRIORITY: Record<FacilityType, number> = {
  hospital: 1, clinic: 2, water: 3, shelter: 4, school: 5, household: 6,
};

/** Fraction of the normal tariff paid by the facility (0 = free). */
export const SUBSIDY_RATE: Record<FacilityType, number> = {
  hospital: 0, clinic: 0, water: 0, shelter: 0, school: 0.25, household: 0.5,
};

export interface Facility {
  meterId: string;
  name: string;
  type: FacilityType;
  demandKwh: number;
  allocatedKwh: number;
}

export interface Donation {
  donorMeterId: string;
  kwh: number;
  at: string;
}

export interface Allocation {
  meterId: string;
  kwh: number;
  costRate: number;
}

interface EmergencyState {
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
  poolKwh: number;
  facilities: Map<string, Facility>;
  donations: Donation[];
  allocations: Allocation[];
}

const state: EmergencyState = {
  active: false, reason: null, activatedAt: null, poolKwh: 0,
  facilities: new Map(), donations: [], allocations: [],
};

/**
 * Priority routing: sort facilities by priority, then by unmet demand
 * (largest first), and greedily fill demand from the pool.
 */
export function routeEnergy(poolKwh: number, facilities: Facility[]): { allocations: Allocation[]; remaining: number } {
  let remaining = poolKwh;
  const allocations: Allocation[] = [];
  const ordered = [...facilities].sort(
    (a, b) =>
      FACILITY_PRIORITY[a.type] - FACILITY_PRIORITY[b.type] ||
      (b.demandKwh - b.allocatedKwh) - (a.demandKwh - a.allocatedKwh),
  );
  for (const f of ordered) {
    if (remaining <= 0) break;
    const need = f.demandKwh - f.allocatedKwh;
    if (need <= 0) continue;
    const kwh = Math.min(need, remaining);
    remaining -= kwh;
    allocations.push({ meterId: f.meterId, kwh, costRate: SUBSIDY_RATE[f.type] });
  }
  return { allocations, remaining };
}

function snapshot() {
  const facilities = [...state.facilities.values()].sort(
    (a, b) => FACILITY_PRIORITY[a.type] - FACILITY_PRIORITY[b.type],
  );
  return {
    active: state.active,
    reason: state.reason,
    activatedAt: state.activatedAt,
    poolKwh: state.poolKwh,
    totalDonatedKwh: state.donations.reduce((s, d) => s + d.kwh, 0),
    donorCount: new Set(state.donations.map((d) => d.donorMeterId)).size,
    facilities,
    recentDonations: state.donations.slice(-20).reverse(),
    allocations: state.allocations.slice(-50).reverse(),
  };
}

emergencyRouter.get("/", (_req, res) => res.json(snapshot()));

emergencyRouter.post("/activate", requireAdminKey, (req, res) => {
  state.active = true;
  state.reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : "Outage";
  state.activatedAt = new Date().toISOString();
  res.json(snapshot());
});

emergencyRouter.post("/deactivate", requireAdminKey, (_req, res) => {
  state.active = false;
  state.reason = null;
  state.activatedAt = null;
  res.json(snapshot());
});

emergencyRouter.post("/facilities", requireAdminKey, (req, res) => {
  const { meterId, name, type, demandKwh } = req.body ?? {};
  if (typeof meterId !== "string" || !meterId || !(type in FACILITY_PRIORITY) || !(Number(demandKwh) > 0)) {
    return res.status(400).json({ error: "meterId, valid type and positive demandKwh required" });
  }
  const existing = state.facilities.get(meterId);
  state.facilities.set(meterId, {
    meterId,
    name: typeof name === "string" && name ? name.slice(0, 100) : meterId,
    type,
    demandKwh: Number(demandKwh),
    allocatedKwh: existing?.allocatedKwh ?? 0,
  });
  res.status(201).json(state.facilities.get(meterId));
});

emergencyRouter.post("/donations", (req, res) => {
  if (!state.active) return res.status(409).json({ error: "Emergency mode is not active" });
  const { donorMeterId, kwh } = req.body ?? {};
  const amount = Number(kwh);
  if (typeof donorMeterId !== "string" || !donorMeterId || !(amount > 0) || amount > 1000) {
    return res.status(400).json({ error: "donorMeterId and kwh (0-1000] required" });
  }
  const donation = { donorMeterId, kwh: amount, at: new Date().toISOString() };
  state.donations.push(donation);
  state.poolKwh += amount;
  res.status(201).json({ donation, poolKwh: state.poolKwh });
});

emergencyRouter.post("/route", requireAdminKey, (_req, res) => {
  if (!state.active) return res.status(409).json({ error: "Emergency mode is not active" });
  const { allocations, remaining } = routeEnergy(state.poolKwh, [...state.facilities.values()]);
  for (const a of allocations) {
    const f = state.facilities.get(a.meterId);
    if (f) f.allocatedKwh += a.kwh;
  }
  state.poolKwh = remaining;
  state.allocations.push(...allocations);
  res.json({ allocations, remainingPoolKwh: remaining });
});
