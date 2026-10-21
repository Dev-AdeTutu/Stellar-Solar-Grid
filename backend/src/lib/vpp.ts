/**
 * Virtual Power Plant aggregation (#925).
 *
 * A VPP bundles distributed resources — rooftop solar, batteries, EVs,
 * interruptible load — into a single dispatchable unit that can bid into grid
 * service markets on its members' behalf.
 *
 * The three things that make aggregation real rather than cosmetic:
 *
 *  1. **Capability, not nameplate.** Aggregate capacity is derated by an
 *     availability factor and the diversity factor, so a VPP never promises
 *     more than its members can actually deliver at once.
 *  2. **Fair revenue distribution.** Settlement is split by each member's
 *     *delivered* share of the accepted energy, not by nameplate capacity —
 *     so a member that is called on and delivers is paid, and one that does
 *     not is not.
 *  3. **Accountable bids.** A bid reserves capacity and is rejected if the VPP
 *     cannot back it, so members learn about conflicts before dispatch.
 */

export type ResourceType = "solar" | "battery" | "ev" | "load" | "wind";

export type VppResource = {
  id: string;
  vppId: string;
  ownerId: string;
  name: string;
  type: ResourceType;
  /** Nameplate capacity in kW. */
  capacityKw: number;
  /** Currently dispatchable in kW (0 while unavailable). */
  availableKw: number;
  /** Energy held in the device, for storage types. */
  energyKwh: number;
  /** Availability of the device itself, 0-1. */
  uptime: number;
  status: "online" | "offline" | "maintenance";
  enrolledAt: string;
};

export type Vpp = {
  id: string;
  name: string;
  /** Grid service the VPP is registered to provide. */
  service: GridService;
  operatorId: string;
  members: string[];
  /** Derating applied to aggregate capacity, 0-1. */
  availabilityFactor: number;
  /** Diversity of member load, 0-1; lower means members peak together. */
  diversityFactor: number;
  status: "forming" | "active" | "suspended";
  createdAt: string;
};

/** Grid service markets a VPP may bid into. */
export type GridService =
  | "frequency_response"
  | "peak_shaving"
  | "load_balancing"
  | "voltage_support"
  | "backup_capacity";

export const GRID_SERVICES: GridService[] = [
  "frequency_response",
  "peak_shaving",
  "load_balancing",
  "voltage_support",
  "backup_capacity",
];

/**
 * Bid windows per service, in minutes. A market is only open when the current
 * minute falls in its window, which is what makes a bid's validity decidable
 * on-chain-free logic rather than an off-platform calendar.
 */
const SERVICE_BID_WINDOWS: Record<GridService, { opensAtMinute: number; durationMinutes: number }> = {
  frequency_response: { opensAtMinute: 0, durationMinutes: 12 },
  peak_shaving: { opensAtMinute: 0, durationMinutes: 30 },
  load_balancing: { opensAtMinute: 15, durationMinutes: 15 },
  voltage_support: { opensAtMinute: 30, durationMinutes: 30 },
  backup_capacity: { opensAtMinute: 0, durationMinutes: 60 },
};

/** Demand multiplier by service — higher for services that are harder to deliver. */
const SERVICE_DEMAND: Record<GridService, number> = {
  frequency_response: 1.4,
  peak_shaving: 1.1,
  load_balancing: 1.0,
  voltage_support: 1.25,
  backup_capacity: 1.5,
};

export type GridServiceBid = {
  id: string;
  vppId: string;
  service: GridService;
  /** Energy offered in kWh. */
  energyKwh: number;
  /** Price per kWh in XLM. */
  priceXlmPerKwh: number;
  /** Hour the delivery period starts, UTC. */
  deliveryHour: number;
  /** Capacity reserved for this bid, per member. */
  reservedKw: Record<string, number>;
  status: "open" | "accepted" | "rejected" | "settled" | "withdrawn";
  createdAt: string;
  /** Why a bid was rejected, when it was. */
  rejectionReason: string | null;
};

export type RevenueShare = {
  memberId: string;
  resourceId: string | null;
  /** Energy attributed to this member, in kWh. */
  deliveredKwh: number;
  /** Share of total delivered energy, 0-100. */
  sharePct: number;
  amountXlm: number;
  /** Pro-rata share of capacity they committed, 0-100. */
  capacitySharePct: number;
};

export type VppSettlement = {
  id: string;
  bidId: string;
  vppId: string;
  service: GridService;
  deliveredKwh: number;
  totalXlm: number;
  shares: RevenueShare[];
  settledAt: string;
};

export type VppPerformance = {
  vppId: string;
  /** Derated capacity actually deliverable now, in kW. */
  aggregateCapacityKw: number;
  currentlyAvailableKw: number;
  committedKw: number;
  freeCapacityKw: number;
  memberCount: number;
  resourceCount: number;
  /** Share of currently available capacity committed to open bids, 0-100. */
  utilisationPct: number;
  deliveredKwh: number;
  revenueXlm: number;
  openBids: number;
  settledBids: number;
  /** 0-100: how much of the VPP's fleet is offline or in maintenance. */
  healthScore: number;
  measuredAt: string;
};

const vpps = new Map<string, Vpp>();
const resources = new Map<string, VppResource>();
const bids = new Map<string, GridServiceBid>();
const settlements = new Map<string, VppSettlement>();

let idSeq = 1;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${idSeq++}`;
}

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

function requireVpp(vppId: string): Vpp {
  const vpp = vpps.get(vppId);
  if (!vpp) fail("VPP not found", "NOT_FOUND");
  return vpp;
}

function requireResource(resourceId: string): VppResource {
  const resource = resources.get(resourceId);
  if (!resource) fail("Resource not found", "NOT_FOUND");
  return resource;
}

// ── VPP lifecycle ────────────────────────────────────────────────────────────

export function createVpp(params: {
  name: string;
  service: GridService;
  operatorId: string;
  availabilityFactor?: number;
  diversityFactor?: number;
}): Vpp {
  if (!GRID_SERVICES.includes(params.service)) fail("Unsupported grid service", "VALIDATION_ERROR");
  if (!params.name?.trim()) fail("name is required", "VALIDATION_ERROR");
  const availabilityFactor = params.availabilityFactor ?? 0.9;
  const diversityFactor = params.diversityFactor ?? 0.85;
  if (availabilityFactor <= 0 || availabilityFactor > 1) {
    fail("availabilityFactor must be in (0, 1]", "VALIDATION_ERROR");
  }
  if (diversityFactor <= 0 || diversityFactor > 1) {
    fail("diversityFactor must be in (0, 1]", "VALIDATION_ERROR");
  }

  const vpp: Vpp = {
    id: nextId("VPP"),
    name: params.name.trim(),
    service: params.service,
    operatorId: params.operatorId,
    members: [],
    availabilityFactor,
    diversityFactor,
    status: "forming",
    createdAt: new Date().toISOString(),
  };
  vpps.set(vpp.id, vpp);
  return vpp;
}

export function getVpp(vppId: string): Vpp | undefined {
  return vpps.get(vppId);
}

export function listVpps(): Vpp[] {
  return [...vpps.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Enroll a distributed resource. A resource belongs to exactly one VPP. */
export function joinVpp(params: {
  vppId: string;
  ownerId: string;
  name: string;
  type: ResourceType;
  capacityKw: number;
  energyKwh?: number;
  uptime?: number;
}): VppResource {
  const vpp = requireVpp(params.vppId);
  if (vpp.status === "suspended") fail("VPP is suspended", "CONFLICT");
  if (!Number.isFinite(params.capacityKw) || params.capacityKw <= 0) {
    fail("capacityKw must be a positive number", "VALIDATION_ERROR");
  }
  const uptime = params.uptime ?? 1;
  if (uptime < 0 || uptime > 1) fail("uptime must be between 0 and 1", "VALIDATION_ERROR");

  const resource: VppResource = {
    id: nextId("RES"),
    vppId: vpp.id,
    ownerId: params.ownerId,
    name: params.name?.trim() || `${params.type} resource`,
    type: params.type,
    capacityKw: params.capacityKw,
    availableKw: Math.round(params.capacityKw * uptime * 100) / 100,
    energyKwh: params.energyKwh ?? 0,
    uptime,
    status: "online",
    enrolledAt: new Date().toISOString(),
  };
  resources.set(resource.id, resource);
  if (!vpp.members.includes(params.ownerId)) vpp.members.push(params.ownerId);
  // A VPP with members can bid, so it becomes active.
  if (vpp.status === "forming") vpp.status = "active";
  return resource;
}

/** Withdraw a resource; it stops contributing capacity immediately. */
export function leaveVpp(vppId: string, resourceId: string): VppResource {
  const resource = requireResource(resourceId);
  if (resource.vppId !== vppId) fail("Resource does not belong to this VPP", "VALIDATION_ERROR");

  const vpp = requireVpp(vppId);
  const openCommitment = [...bids.values()]
    .filter((bid) => bid.vppId === vppId && (bid.status === "open" || bid.status === "accepted"))
    .reduce((sum, bid) => sum + (bid.reservedKw[resourceId] ?? 0), 0);
  if (openCommitment > 0) {
    fail("Resource is committed to an open grid-service bid", "CONFLICT");
  }

  resources.delete(resourceId);
  if (![...resources.values()].some((r) => r.vppId === vppId && r.ownerId === resource.ownerId)) {
    vpp.members = vpp.members.filter((member) => member !== resource.ownerId);
  }
  if (vpp.members.length === 0) vpp.status = "forming";
  return resource;
}

export function listResources(vppId: string): VppResource[] {
  return [...resources.values()].filter((resource) => resource.vppId === vppId);
}

export function getResource(resourceId: string): VppResource | undefined {
  return resources.get(resourceId);
}

/** Update a resource's live availability (metering or a manual override). */
export function updateResourceAvailability(
  resourceId: string,
  update: { availableKw?: number; status?: VppResource["status"]; energyKwh?: number; uptime?: number },
): VppResource {
  const resource = requireResource(resourceId);
  if (update.availableKw !== undefined) {
    if (update.availableKw < 0 || update.availableKw > resource.capacityKw) {
      fail("availableKw must be between 0 and capacityKw", "VALIDATION_ERROR");
    }
    resource.availableKw = update.availableKw;
  }
  if (update.status) {
    resource.status = update.status;
    if (update.status !== "online") {
      // An offline resource contributes nothing, whatever it last reported.
      resource.availableKw = 0;
    } else if (update.availableKw === undefined) {
      // Coming back online restores dispatchability from uptime; leaving it at
      // zero would strand a member's capacity after any transient outage.
      resource.availableKw = round2(resource.capacityKw * resource.uptime);
    }
  }
  if (update.uptime !== undefined) {
    if (update.uptime < 0 || update.uptime > 1) fail("uptime must be between 0 and 1", "VALIDATION_ERROR");
    resource.uptime = update.uptime;
  }
  if (update.energyKwh !== undefined) {
    if (update.energyKwh < 0) fail("energyKwh must be non-negative", "VALIDATION_ERROR");
    resource.energyKwh = update.energyKwh;
  }
  return resource;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Capability the VPP can credibly commit, in kW. */
export function aggregateCapacityKw(vppId: string): number {
  const vpp = requireVpp(vppId);
  const nameplate = listResources(vppId).reduce((sum, resource) => sum + resource.capacityKw, 0);
  // Both deratings compound: the fleet is not fully available, and its members
  // do not all peak at once.
  return round2(nameplate * vpp.availabilityFactor * vpp.diversityFactor);
}

/** Capacity actually dispatchable right now, in kW. */
export function availableCapacityKw(vppId: string): number {
  return round2(
    listResources(vppId)
      .filter((resource) => resource.status === "online")
      .reduce((sum, resource) => sum + resource.availableKw, 0),
  );
}

/** Capacity already committed to bids that have not settled. */
export function committedCapacityKw(vppId: string): number {
  return round2(
    [...bids.values()]
      .filter((bid) => bid.vppId === vppId && (bid.status === "open" || bid.status === "accepted"))
      .reduce((sum, bid) => sum + Object.values(bid.reservedKw).reduce((s, kw) => s + kw, 0), 0),
  );
}

/**
 * Split a requested capacity across members pro-rata to what each can
 * actually deliver, capped at each resource's availability.
 */
function allocate(vppId: string, requestedKw: number): Record<string, number> | null {
  const fleet = listResources(vppId).filter((resource) => resource.status === "online");
  if (fleet.length === 0) return null;

  const available = fleet.reduce((sum, resource) => sum + resource.availableKw, 0);
  if (available <= 0) return null;

  const reserved: Record<string, number> = {};
  let remaining = requestedKw;
  // Largest-first so a small request concentrates on the resources that can
  // actually carry it, rather than being spread too thin to dispatch.
  for (const resource of [...fleet].sort((a, b) => b.availableKw - a.availableKw)) {
    if (remaining <= 0) break;
    const share = Math.min(resource.availableKw, (resource.availableKw / available) * requestedKw);
    const allocation = round2(share);
    if (allocation > 0) {
      reserved[resource.id] = allocation;
      remaining = round2(remaining - allocation);
    }
  }
  return Object.keys(reserved).length > 0 ? reserved : null;
}

// ── Grid-service bidding ─────────────────────────────────────────────────────

/** Whether `service` is accepting bids at `now`. */
export function isServiceOpen(service: GridService, now = new Date()): boolean {
  const window = SERVICE_BID_WINDOWS[service];
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minuteOfDay >= window.opensAtMinute && minuteOfDay < window.opensAtMinute + window.durationMinutes;
}

export function listOpenServices(now = new Date()): GridService[] {
  return GRID_SERVICES.filter((service) => isServiceOpen(service, now));
}

/**
 * Bid the VPP's spare capacity into a grid service market.
 *
 * A bid is rejected outright when the VPP cannot back it, so a member never
 * signs up for energy the fleet cannot deliver.
 */
export function submitBid(params: {
  vppId: string;
  energyKwh: number;
  priceXlmPerKwh: number;
  deliveryHour?: number;
  now?: Date;
}): GridServiceBid {
  const vpp = requireVpp(params.vppId);
  const now = params.now ?? new Date();
  if (vpp.status !== "active") fail("VPP is not active", "CONFLICT");
  if (!isServiceOpen(vpp.service, now)) {
    fail(`The ${vpp.service.replace(/_/g, " ")} market is not open right now`, "CONFLICT");
  }
  if (!Number.isFinite(params.energyKwh) || params.energyKwh <= 0) {
    fail("energyKwh must be a positive number", "VALIDATION_ERROR");
  }
  if (!Number.isFinite(params.priceXlmPerKwh) || params.priceXlmPerKwh <= 0) {
    fail("priceXlmPerKwh must be a positive number", "VALIDATION_ERROR");
  }

  const deliveryHour = params.deliveryHour ?? (now.getUTCHours() + 1) % 24;
  // A bid's capacity is derived from its energy over the delivery hour, so the
  // two can never disagree.
  const requestedKw = params.energyKwh;

  const free = round2(availableCapacityKw(vpp.id) - committedCapacityKw(vpp.id));
  const requested = Math.min(requestedKw, Math.max(0, free));
  const reserved = requested > 0 ? allocate(vpp.id, requested) : null;

  const bid: GridServiceBid = {
    id: nextId("BID"),
    vppId: vpp.id,
    service: vpp.service,
    energyKwh: params.energyKwh,
    priceXlmPerKwh: params.priceXlmPerKwh,
    deliveryHour,
    reservedKw: reserved ?? {},
    status: "open",
    createdAt: now.toISOString(),
    rejectionReason: null,
  };

  if (!reserved) {
    // A grid operator would never see this bid; recording it keeps the
    // rejection auditable rather than silently dropping it.
    bid.status = "rejected";
    bid.rejectionReason =
      "VPP has no dispatchable capacity available — members are offline or fully committed";
  }
  bids.set(bid.id, bid);
  return bid;
}

export function getBid(bidId: string): GridServiceBid | undefined {
  return bids.get(bidId);
}

export function listBids(vppId: string, status?: GridServiceBid["status"]): GridServiceBid[] {
  return [...bids.values()]
    .filter((bid) => bid.vppId === vppId && (status === undefined || bid.status === status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function withdrawBid(bidId: string): GridServiceBid {
  const bid = bids.get(bidId);
  if (!bid) fail("Bid not found", "NOT_FOUND");
  if (bid.status !== "open") fail("Only open bids can be withdrawn", "CONFLICT");
  bid.status = "withdrawn";
  return bid;
}

// ── Dispatch and fair settlement ─────────────────────────────────────────────

/**
 * Settle an accepted bid and split the revenue fairly.
 *
 * `deliveredKwhByResource` is what each member actually delivered. Members who
 * delivered nothing receive nothing — that is the fairness rule. Members who
 * delivered a full share receive the base market price; members who
 * under-deliver are paid proportionally to what they delivered, so there is no
 * reward for being called on and failing to show up.
 */
export function settleBid(params: {
  bidId: string;
  deliveredKwhByResource: Record<string, number>;
  now?: Date;
}): VppSettlement {
  const bid = bids.get(params.bidId);
  if (!bid) fail("Bid not found", "NOT_FOUND");
  if (bid.status !== "accepted" && bid.status !== "open") {
    fail("Only an accepted bid can be settled", "CONFLICT");
  }
  const now = params.now ?? new Date();
  const vpp = requireVpp(bid.vppId);
  const demand = SERVICE_DEMAND[bid.service];

  // Delivered energy is credited against what was offered, capped per resource
  // at the capacity it reserved, so a meter over-reporting cannot inflate the
  // grid operator's bill beyond the bid.
  const fleet = listResources(bid.vppId);
  const totalReserved = Object.values(bid.reservedKw).reduce((sum, kw) => sum + kw, 0);

  const perMember = new Map<string, { delivered: number; reserved: number }>();
  let deliveredKwh = 0;
  for (const resource of fleet) {
    const reported = params.deliveredKwhByResource[resource.id] ?? 0;
    const reservedKw = bid.reservedKw[resource.id] ?? 0;
    const capped = Math.max(0, Math.min(reported, reservedKw > 0 ? reservedKw : reported));
    deliveredKwh += capped;
    const entry = perMember.get(resource.ownerId) ?? { delivered: 0, reserved: 0 };
    entry.delivered += capped;
    entry.reserved += reservedKw;
    perMember.set(resource.ownerId, entry);
  }

  // Higher-demand services pay a premium over the bid price.
  const totalXlm = round2(deliveredKwh * bid.priceXlmPerKwh * demand);

  // One row per member, paid on delivered energy. A member that delivered
  // nothing receives nothing — that is the fairness rule — and still appears
  // so the shortfall against what they committed is visible.
  const shares: RevenueShare[] = [...perMember.entries()].map(([memberId, entry]) => ({
    memberId,
    resourceId: null,
    deliveredKwh: round2(entry.delivered),
    sharePct: deliveredKwh > 0 ? round2((entry.delivered / deliveredKwh) * 100) : 0,
    amountXlm: deliveredKwh > 0 ? round2((entry.delivered / deliveredKwh) * totalXlm) : 0,
    capacitySharePct: totalReserved > 0 ? round2((entry.reserved / totalReserved) * 100) : 0,
  }));

  // Give any rounding remainder to the largest contributor so the shares always
  // add up to the settled total.
  const allocated = round2(shares.reduce((sum, share) => sum + share.amountXlm, 0));
  const drift = round2(totalXlm - allocated);
  if (drift !== 0 && shares.length > 0) {
    const largest = shares.reduce((best, share) => (share.amountXlm > best.amountXlm ? share : best));
    largest.amountXlm = round2(largest.amountXlm + drift);
  }

  const settlement: VppSettlement = {
    id: nextId("SETTLE"),
    bidId: bid.id,
    vppId: vpp.id,
    service: bid.service,
    deliveredKwh: round2(deliveredKwh),
    totalXlm,
    shares: shares.sort((a, b) => b.amountXlm - a.amountXlm),
    settledAt: now.toISOString(),
  };
  settlements.set(settlement.id, settlement);
  bid.status = "settled";
  return settlement;
}

export function getSettlement(settlementId: string): VppSettlement | undefined {
  return settlements.get(settlementId);
}

export function listSettlements(vppId: string): VppSettlement[] {
  return [...settlements.values()]
    .filter((settlement) => settlement.vppId === vppId)
    .sort((a, b) => a.settledAt.localeCompare(b.settledAt));
}

// ── Performance monitoring ───────────────────────────────────────────────────

export function getPerformance(vppId: string): VppPerformance {
  const vpp = requireVpp(vppId);
  const fleet = listResources(vppId);
  const available = availableCapacityKw(vppId);
  const committed = committedCapacityKw(vppId);
  const vppSettlements = listSettlements(vppId);
  const healthy = fleet.filter((resource) => resource.status === "online").length;

  return {
    vppId,
    aggregateCapacityKw: aggregateCapacityKw(vppId),
    currentlyAvailableKw: available,
    committedKw: committed,
    freeCapacityKw: round2(Math.max(0, available - committed)),
    memberCount: vpp.members.length,
    resourceCount: fleet.length,
    utilisationPct: available > 0 ? round2((committed / available) * 100) : 0,
    deliveredKwh: round2(vppSettlements.reduce((sum, s) => sum + s.deliveredKwh, 0)),
    revenueXlm: round2(vppSettlements.reduce((sum, s) => sum + s.totalXlm, 0)),
    openBids: listBids(vppId).filter((bid) => bid.status === "open").length,
    settledBids: vppSettlements.length,
    healthScore: fleet.length === 0 ? 0 : Math.round((healthy / fleet.length) * 100),
    measuredAt: new Date().toISOString(),
  };
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/** Reset all VPP state. Test-only. */
export function resetVppsForTests(): void {
  vpps.clear();
  resources.clear();
  bids.clear();
  settlements.clear();
  idSeq = 1;
}
