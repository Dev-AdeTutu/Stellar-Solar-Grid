/**
 * Client for the energy portfolio API (#926).
 */
import { env } from "@/lib/env";

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/portfolio`;

export type AssetType = "solar" | "wind" | "storage" | "hydro" | "grid";

export type PortfolioAsset = {
  id: string;
  ownerId: string;
  type: AssetType;
  name: string;
  capacityKw: number;
  costBasisXlm: number;
  energyKwh: number;
  availableHours: number;
  addedAt: string;
};

export type AllocationSlice = {
  assetId: string;
  type: AssetType;
  name: string;
  capacityKw: number;
  weightPct: number;
  currentWeightPct: number;
  deltaKw: number;
  expectedReturnPct: number | null;
  riskScore: number;
};

export type AllocationRecommendation = {
  allocations: AllocationSlice[];
  rationale: string;
  targetRiskScore: number;
  generatedAt: string;
};

export type RebalanceAction = {
  assetId: string;
  type: AssetType;
  action: "increase" | "decrease" | "hold";
  deltaKw: number;
  reason: string;
};

export type RebalancePlan = {
  actions: RebalanceAction[];
  netDeltaKw: number;
  estimatedCostXlm: number;
  riskBefore: number;
  riskAfter: number;
  generatedAt: string;
};

export type PortfolioPerformance = {
  totalCapacityKw: number;
  totalEnergyKwh: number;
  totalCostBasisXlm: number;
  roiPct: number | null;
  efficiencyPct: number | null;
  uptimePct: number;
  revenueXlm: number;
  byType: Array<{
    type: AssetType;
    capacityKw: number;
    energyKwh: number;
    sharePct: number;
    roiPct: number | null;
  }>;
};

export type PortfolioRisk = {
  score: number;
  band: "low" | "moderate" | "high" | "very_high";
  concentration: number;
  volatility: number;
  factors: string[];
};

export type PortfolioDashboard = {
  ownerId: string;
  assets: PortfolioAsset[];
  assetCount: number;
  performance: PortfolioPerformance;
  risk: PortfolioRisk;
  recommendation: AllocationRecommendation;
  rebalance: RebalancePlan;
  generatedAt: string;
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

export function fetchDashboard(ownerId: string): Promise<PortfolioDashboard> {
  return getJson<PortfolioDashboard>(`${API}/${encodeURIComponent(ownerId)}`);
}

export async function addAsset(
  ownerId: string,
  body: { type: AssetType; name: string; capacityKw: number; energyKwh?: number },
): Promise<PortfolioAsset> {
  const res = await fetch(`${API}/${encodeURIComponent(ownerId)}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as PortfolioAsset;
}

export async function recordDelivery(ownerId: string, assetId: string, energyKwh: number) {
  const res = await fetch(
    `${API}/${encodeURIComponent(ownerId)}/assets/${encodeURIComponent(assetId)}/delivery`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ energyKwh }) },
  );
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as PortfolioAsset;
}

export async function applyRebalance(ownerId: string, targetRiskScore?: number): Promise<RebalancePlan> {
  const res = await fetch(`${API}/${encodeURIComponent(ownerId)}/rebalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(targetRiskScore === undefined ? {} : { targetRiskScore }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as RebalancePlan;
}

export function formatPercent(value: number | null, suffix = "%"): string {
  return value == null ? "—" : `${value.toFixed(1)}${suffix}`;
}

export function formatKw(kw: number): string {
  return `${kw >= 0 ? "+" : ""}${kw.toFixed(1)} kW`;
}

export const RISK_BADGE: Record<PortfolioRisk["band"], string> = {
  low: "bg-green-900/40 text-green-300",
  moderate: "bg-yellow-900/40 text-yellow-300",
  high: "bg-orange-900/40 text-orange-300",
  very_high: "bg-red-900/40 text-red-300",
};

/** Composition rows for the dashboard chart, ordered by capacity. */
export function compositionData(performance: PortfolioPerformance) {
  return [...performance.byType].sort((a, b) => b.capacityKw - a.capacityKw);
}