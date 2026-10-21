/**
 * Client for the virtual power plant API (#925).
 */
import { env } from "@/lib/env";

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/vpp`;

export type ResourceType = "solar" | "battery" | "ev" | "load" | "wind";

export type GridService =
  | "frequency_response"
  | "peak_shaving"
  | "load_balancing"
  | "voltage_support"
  | "backup_capacity";

export type VppResource = {
  id: string;
  vppId: string;
  ownerId: string;
  name: string;
  type: ResourceType;
  capacityKw: number;
  availableKw: number;
  energyKwh: number;
  uptime: number;
  status: "online" | "offline" | "maintenance";
  enrolledAt: string;
};

export type Vpp = {
  id: string;
  name: string;
  service: GridService;
  operatorId: string;
  members: string[];
  availabilityFactor: number;
  diversityFactor: number;
  status: "forming" | "active" | "suspended";
  createdAt: string;
  resources: VppResource[];
};

export type GridServiceBid = {
  id: string;
  vppId: string;
  service: GridService;
  energyKwh: number;
  priceXlmPerKwh: number;
  deliveryHour: number;
  reservedKw: Record<string, number>;
  status: "open" | "accepted" | "rejected" | "settled" | "withdrawn";
  createdAt: string;
  rejectionReason: string | null;
};

export type RevenueShare = {
  memberId: string;
  resourceId: string | null;
  deliveredKwh: number;
  sharePct: number;
  amountXlm: number;
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
  aggregateCapacityKw: number;
  currentlyAvailableKw: number;
  committedKw: number;
  freeCapacityKw: number;
  memberCount: number;
  resourceCount: number;
  utilisationPct: number;
  deliveredKwh: number;
  revenueXlm: number;
  openBids: number;
  settledBids: number;
  healthScore: number;
  measuredAt: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as T;
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (HTTP ${res.status})`;
}

export async function listVpps(): Promise<Vpp[]> {
  return (await getJson<{ vpps: Vpp[] }>(`${API}/`)).vpps;
}

export async function fetchVpp(vppId: string): Promise<Vpp> {
  return getJson<Vpp>(`${API}/${encodeURIComponent(vppId)}`);
}

export async function fetchPerformance(vppId: string): Promise<VppPerformance> {
  return getJson<VppPerformance>(`${API}/${encodeURIComponent(vppId)}/performance`);
}

export async function fetchBids(vppId: string): Promise<GridServiceBid[]> {
  return (await getJson<{ bids: GridServiceBid[] }>(`${API}/${encodeURIComponent(vppId)}/bids`)).bids;
}

export async function fetchSettlements(vppId: string): Promise<VppSettlement[]> {
  return (
    await getJson<{ settlements: VppSettlement[] }>(`${API}/${encodeURIComponent(vppId)}/settlements`)
  ).settlements;
}

export async function createVpp(body: { name: string; service: GridService; operatorId: string }): Promise<Vpp> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as Vpp;
}

export async function joinVpp(
  vppId: string,
  body: { ownerId: string; name: string; type: ResourceType; capacityKw: number },
): Promise<VppResource> {
  const res = await fetch(`${API}/${encodeURIComponent(vppId)}/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as VppResource;
}

export async function submitBid(
  vppId: string,
  body: { energyKwh: number; priceXlmPerKwh: number },
): Promise<GridServiceBid> {
  const res = await fetch(`${API}/${encodeURIComponent(vppId)}/bids`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as GridServiceBid;
}

export async function settleBid(
  bidId: string,
  deliveredKwhByResource: Record<string, number>,
): Promise<VppSettlement> {
  const res = await fetch(`${API}/bids/${encodeURIComponent(bidId)}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliveredKwhByResource }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as VppSettlement;
}

export const SERVICE_LABEL: Record<GridService, string> = {
  frequency_response: "Frequency response",
  peak_shaving: "Peak shaving",
  load_balancing: "Load balancing",
  voltage_support: "Voltage support",
  backup_capacity: "Backup capacity",
};

export const BID_STATUS_BADGE: Record<GridServiceBid["status"], string> = {
  open: "bg-blue-900/40 text-blue-300",
  accepted: "bg-green-900/40 text-green-300",
  rejected: "bg-red-900/40 text-red-300",
  settled: "bg-solar-500/20 text-solar-300",
  withdrawn: "bg-white/10 text-white/60",
};

export function formatXlm(value: number, digits = 3): string {
  return `${value.toFixed(digits)} XLM`;
}