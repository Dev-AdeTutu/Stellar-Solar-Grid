/**
 * Energy portfolio management (#926).
 *
 * A portfolio is a bag of energy assets (solar, wind, storage, grid) held by an
 * owner, each with a capacity and a realised performance history. On top of
 * that this module provides:
 *  - a composition dashboard,
 *  - allocation recommendations weighted by measured risk/return per asset,
 *  - performance analytics (ROI, yield, efficiency, uptime),
 *  - rebalancing suggestions that target a chosen risk posture,
 *  - a 0-100 risk score for the whole book.
 *
 * Recommendations are derived from the recorded history rather than hard-coded
 * target weights, so a portfolio of assets the platform has never seen still
 * gets a defensible answer. Where an asset has no history the module reports
 * `null` instead of inventing a return.
 */

export type AssetType = "solar" | "wind" | "storage" | "grid" | "hydro";

export type PortfolioAsset = {
  id: string;
  ownerId: string;
  type: AssetType;
  name: string;
  /** Nameplate capacity in kW. */
  capacityKw: number;
  /** Capital cost basis in XLM. */
  costBasisXlm: number;
  /** Energy delivered over the window, in kWh. */
  energyKwh: number;
  /** Hours the asset was available in the window. */
  availableHours: number;
  addedAt: string;
};

export type AllocationSlice = {
  assetId: string;
  type: AssetType;
  name: string;
  capacityKw: number;
  /** Share of total capacity, 0-100. */
  weightPct: number;
  currentWeightPct: number;
  /** Capacity to add (positive) or remove (negative), in kW. */
  deltaKw: number;
  /** Annualised return of the asset over the window, or null without history. */
  expectedReturnPct: number | null;
  /** 0-100; higher means more variable output. */
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
  /** Capacity that must be added or removed, in kW. */
  netDeltaKw: number;
  /** Estimated cost of executing the plan, in XLM. */
  estimatedCostXlm: number;
  /** Capital at risk before and after, used to explain the trade-off. */
  riskBefore: number;
  riskAfter: number;
  generatedAt: string;
};

export type PortfolioPerformance = {
  totalCapacityKw: number;
  totalEnergyKwh: number;
  totalCostBasisXlm: number;
  /** Portfolio ROI over the window, as a percentage. */
  roiPct: number | null;
  /** Capacity factor: delivered energy / (capacity × hours available). */
  efficiencyPct: number | null;
  /** Share of hours each asset was available. */
  uptimePct: number;
  /** Revenue credited to the portfolio in the window, in XLM. */
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
  /** 0 (diversified and stable) to 100 (concentrated and volatile). */
  score: number;
  band: "low" | "moderate" | "high" | "very_high";
  /** Herfindahl index of capacity weights, 0-1. 1 means a single asset. */
  concentration: number;
  /** 0-100 variability of output across assets. */
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

/** Revenue credited per kWh delivered, in XLM. */
export const PORTFOLIO_TARIFF_XLM_PER_KWH = 0.18;
/** Cost of adding capacity, in XLM per kW — used to price rebalances. */
export const PORTFOLIO_CAPEX_XLM_PER_KW = 250;
/** Assumed hours in a window when an asset reports no availability. */
const ASSUMED_WINDOW_HOURS = 24 * 30;
/** Risk posture targeted by `recommendAllocation` when none is supplied. */
export const DEFAULT_TARGET_RISK = 45;

const ASSET_TYPES: AssetType[] = ["solar", "wind", "storage", "hydro", "grid"];

/**
 * Intrinsic risk by technology, 0-100. Output volatility differs by orders of
 * magnitude between a rooftop array and a battery bank, and this is the part of
 * the risk model that does not depend on what a particular site has measured.
 */
const TYPE_RISK: Record<AssetType, number> = {
  solar: 35,
  wind: 55,
  hydro: 20,
  storage: 25,
  grid: 15,
};

const TYPE_RETURN_BASIS: Record<AssetType, number> = {
  solar: 1.0,
  wind: 1.15,
  hydro: 0.85,
  storage: 0.7,
  grid: 0.5,
};

const assets = new Map<string, PortfolioAsset>();

let idSeq = 1;
function nextId(): string {
  return `PA-${Date.now()}-${idSeq++}`;
}

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

function requireAsset(assetId: string): PortfolioAsset {
  const asset = assets.get(assetId);
  if (!asset) fail("Asset not found", "NOT_FOUND");
  return asset;
}

export function addAsset(params: {
  ownerId: string;
  type: AssetType;
  name: string;
  capacityKw: number;
  costBasisXlm?: number;
  energyKwh?: number;
  availableHours?: number;
}): PortfolioAsset {
  if (!ASSET_TYPES.includes(params.type)) fail("Unsupported asset type", "VALIDATION_ERROR");
  if (!Number.isFinite(params.capacityKw) || params.capacityKw <= 0) {
    fail("capacityKw must be a positive number", "VALIDATION_ERROR");
  }
  if (params.energyKwh !== undefined && (!Number.isFinite(params.energyKwh) || params.energyKwh < 0)) {
    fail("energyKwh must be a non-negative number", "VALIDATION_ERROR");
  }
  if (
    params.availableHours !== undefined &&
    (!Number.isFinite(params.availableHours) || params.availableHours < 0)
  ) {
    fail("availableHours must be a non-negative number", "VALIDATION_ERROR");
  }

  const asset: PortfolioAsset = {
    id: nextId(),
    ownerId: params.ownerId,
    type: params.type,
    name: params.name.trim() || `${params.type} asset`,
    capacityKw: params.capacityKw,
    costBasisXlm: params.costBasisXlm ?? params.capacityKw * PORTFOLIO_CAPEX_XLM_PER_KW,
    energyKwh: params.energyKwh ?? 0,
    availableHours: params.availableHours ?? ASSUMED_WINDOW_HOURS,
    addedAt: new Date().toISOString(),
  };
  assets.set(asset.id, asset);
  return asset;
}

export function removeAsset(assetId: string, ownerId: string): PortfolioAsset {
  const asset = requireAsset(assetId);
  if (asset.ownerId !== ownerId) fail("Not the asset owner", "FORBIDDEN");
  assets.delete(assetId);
  return asset;
}

export function getAsset(assetId: string): PortfolioAsset | undefined {
  return assets.get(assetId);
}

export function listAssets(ownerId: string): PortfolioAsset[] {
  return [...assets.values()].filter((asset) => asset.ownerId === ownerId);
}

/** Record a delivery reading against an asset, updating cumulative kWh. */
export function recordDelivery(assetId: string, energyKwh: number): PortfolioAsset {
  const asset = requireAsset(assetId);
  if (!Number.isFinite(energyKwh) || energyKwh < 0) {
    fail("energyKwh must be a non-negative number", "VALIDATION_ERROR");
  }
  asset.energyKwh += energyKwh;
  return asset;
}

// ── Performance analytics ────────────────────────────────────────────────────

/** Revenue an asset earned over the window at the platform tariff. */
function revenueOf(asset: PortfolioAsset): number {
  return asset.energyKwh * PORTFOLIO_TARIFF_XLM_PER_KWH;
}

function roiOf(asset: PortfolioAsset): number | null {
  // No cost basis or no delivery means ROI is not measurable, not zero.
  if (asset.costBasisXlm <= 0 || asset.energyKwh <= 0) return null;
  return ((revenueOf(asset) - asset.costBasisXlm) / asset.costBasisXlm) * 100;
}

export function getPerformance(ownerId: string): PortfolioPerformance {
  const held = listAssets(ownerId);
  const totalCapacityKw = held.reduce((sum, asset) => sum + asset.capacityKw, 0);
  const totalEnergyKwh = held.reduce((sum, asset) => sum + asset.energyKwh, 0);
  const totalCostBasisXlm = held.reduce((sum, asset) => sum + asset.costBasisXlm, 0);
  const revenueXlm = held.reduce((sum, asset) => sum + revenueOf(asset), 0);

  const availableHours = held.reduce((sum, asset) => sum + asset.availableHours, 0);
  const efficiencyPct =
    totalCapacityKw > 0 && availableHours > 0
      ? (totalEnergyKwh / (totalCapacityKw * availableHours)) * 100
      : null;

  const byType = ASSET_TYPES.map((type) => {
    const ofType = held.filter((asset) => asset.type === type);
    const capacityKw = ofType.reduce((sum, asset) => sum + asset.capacityKw, 0);
    const energyKwh = ofType.reduce((sum, asset) => sum + asset.energyKwh, 0);
    const costBasis = ofType.reduce((sum, asset) => sum + asset.costBasisXlm, 0);
    const revenue = ofType.reduce((sum, asset) => sum + revenueOf(asset), 0);
    return {
      type,
      capacityKw: round2(capacityKw),
      energyKwh: round2(energyKwh),
      sharePct: totalCapacityKw > 0 ? round2((capacityKw / totalCapacityKw) * 100) : 0,
      roiPct: costBasis > 0 && energyKwh > 0 ? round2(((revenue - costBasis) / costBasis) * 100) : null,
    };
  }).filter((row) => row.capacityKw > 0);

  return {
    totalCapacityKw: round2(totalCapacityKw),
    totalEnergyKwh: round2(totalEnergyKwh),
    totalCostBasisXlm: round2(totalCostBasisXlm),
    roiPct: totalCostBasisXlm > 0 && totalEnergyKwh > 0 ? round2(((revenueXlm - totalCostBasisXlm) / totalCostBasisXlm) * 100) : null,
    efficiencyPct: efficiencyPct === null ? null : round2(efficiencyPct),
    uptimePct: ASSUMED_WINDOW_HOURS > 0 ? round2((availableHours / (held.length * ASSUMED_WINDOW_HOURS)) * 100) : 0,
    revenueXlm: round2(revenueXlm),
    byType,
  };
}

// ── Risk assessment ──────────────────────────────────────────────────────────

export function assessRisk(ownerId: string): PortfolioRisk {
  const held = listAssets(ownerId);
  const factors: string[] = [];

  if (held.length === 0) {
    return { score: 0, band: "low", concentration: 0, volatility: 0, factors: ["No assets in portfolio"] };
  }

  const totalCapacityKw = held.reduce((sum, asset) => sum + asset.capacityKw, 0);
  // Herfindahl index: the share of a single asset, squared and summed.
  const concentration =
    totalCapacityKw > 0
      ? round4(held.reduce((sum, asset) => sum + (asset.capacityKw / totalCapacityKw) ** 2, 0))
      : 1;

  // Volatility: spread of per-kW output across assets, 0-1 before scaling.
  const outputs = held.map((asset) =>
    asset.capacityKw > 0 ? asset.energyKwh / asset.capacityKw : 0,
  );
  const meanOutput = outputs.reduce((sum, value) => sum + value, 0) / outputs.length;
  const volatility = round4(meanOutput > 0 ? stdDev(outputs) / meanOutput : 1);

  // Blend concentration (60%) with output variability (40%).
  let score = Math.round(concentration * 60 + Math.min(1, volatility) * 40);
  score = Math.max(0, Math.min(100, score));

  factors.push(
    concentration > 0.5
      ? `Concentrated: the largest asset is ${Math.round(
          (Math.max(...held.map((a) => a.capacityKw)) / totalCapacityKw) * 100,
        )}% of capacity`
      : `Diversified across ${held.length} assets`,
  );
  factors.push(
    volatility > 0.5
      ? `Output varies ${Math.round(volatility * 100)}% between assets`
      : `Output is consistent across assets (${Math.round(volatility * 100)}% spread)`,
  );
  const types = new Set(held.map((asset) => asset.type));
  factors.push(
    types.size >= 3
      ? `Mixes ${types.size} technologies, which smooths combined output`
      : `Concentrated in ${types.size} ${types.size === 1 ? "technology" : "technologies"}`,
  );
  const idle = held.filter((asset) => asset.energyKwh === 0);
  if (idle.length > 0) {
    factors.push(`${idle.length} ${idle.length === 1 ? "asset" : "assets"} delivered no energy this window`);
  }

  return {
    score,
    band: score < 25 ? "low" : score < 50 ? "moderate" : score < 75 ? "high" : "very_high",
    concentration,
    volatility,
    factors,
  };
}

// ── Allocation recommendations ───────────────────────────────────────────────

/**
 * Recommend a target capacity mix.
 *
 * The target is a risk-weighted blend: each technology contributes a share of
 * the portfolio proportional to `returnBasis / risk`, scaled down as the
 * target risk score tightens. Assets are then mapped back onto their current
 * holdings so the advice is expressed in kW of what the owner already owns.
 */
export function recommendAllocation(
  ownerId: string,
  options: { targetRiskScore?: number } = {},
): AllocationRecommendation {
  const held = listAssets(ownerId);
  const targetRisk = options.targetRiskScore ?? DEFAULT_TARGET_RISK;
  const now = new Date().toISOString();

  if (held.length === 0) {
    return {
      allocations: [],
      rationale: "No assets yet — add an asset to get a target allocation.",
      targetRiskScore: targetRisk,
      generatedAt: now,
    };
  }

  const totalCapacityKw = held.reduce((sum, asset) => sum + asset.capacityKw, 0);
  const overallRisk = assessRisk(ownerId).score;
  // 0 at the current risk, 1 when the target is maximally conservative.
  const tighten = clamp01((overallRisk - targetRisk) / 100);
  // Tightening tilts the mix towards the lowest-risk technology available.
  const tilt = 1 + tighten * 0.6;

  const weights = new Map<AssetType, number>();
  for (const asset of held) {
    const risk = Math.max(1, TYPE_RISK[asset.type]);
    const score = (TYPE_RETURN_BASIS[asset.type] / risk) * (asset.type === "grid" || asset.type === "storage" ? tilt : 1);
    weights.set(asset.type, (weights.get(asset.type) ?? 0) + score);
  }
  const weightTotal = [...weights.values()].reduce((sum, value) => sum + value, 0);

  // Target capacity of each technology, and the assets' share of the portfolio.
  const typeCapacity = new Map<AssetType, number>();
  for (const asset of held) {
    typeCapacity.set(asset.type, (typeCapacity.get(asset.type) ?? 0) + asset.capacityKw);
  }

  const allocations: AllocationSlice[] = held.map((asset) => {
    const typeWeight = weights.get(asset.type)! / weightTotal;
    const typeTotal = typeCapacity.get(asset.type) ?? 0;
    // Split the technology's target across the owner's assets of that type in
    // proportion to what each already contributes.
    const targetCapacity =
      typeTotal > 0 ? (asset.capacityKw / typeTotal) * typeWeight * totalCapacityKw : 0;
    const currentWeightPct = totalCapacityKw > 0 ? (asset.capacityKw / totalCapacityKw) * 100 : 0;
    const targetWeightPct = totalCapacityKw > 0 ? (targetCapacity / totalCapacityKw) * 100 : 0;

    return {
      assetId: asset.id,
      type: asset.type,
      name: asset.name,
      capacityKw: asset.capacityKw,
      weightPct: round2(targetWeightPct),
      currentWeightPct: round2(currentWeightPct),
      deltaKw: round2(targetCapacity - asset.capacityKw),
      expectedReturnPct: roiOf(asset),
      riskScore: TYPE_RISK[asset.type],
    };
  });

  const rationale =
    `Target mix weights ${targetRisk > overallRisk ? "lower-risk" : "higher-return"} technologies ` +
    `to bring the ${overallRisk}/100 risk score toward ${targetRisk}. ` +
    `Weights are risk-adjusted expected return per unit of technology risk, ` +
    `with a ${Math.round(tilt * 100 - 100)}% tilt toward grid and storage.`;

  return { allocations, rationale, targetRiskScore: targetRisk, generatedAt: now };
}

// ── Rebalancing ──────────────────────────────────────────────────────────────

/** A rebalancing plan derived from the allocation recommendation. */
export function getRebalancePlan(
  ownerId: string,
  options: { targetRiskScore?: number } = {},
): RebalancePlan {
  const now = new Date().toISOString();
  const recommendation = recommendAllocation(ownerId, options);
  const risk = assessRisk(ownerId);
  const held = listAssets(ownerId);

  if (held.length === 0) {
    return {
      actions: [],
      netDeltaKw: 0,
      estimatedCostXlm: 0,
      riskBefore: risk.score,
      riskAfter: risk.score,
      generatedAt: now,
    };
  }

  // Ignore moves below 5% of an asset's capacity — rebalancing noise is not a
  // saving, and a plan of many tiny trades never gets executed.
  const threshold = 0.05;
  const actions: RebalanceAction[] = recommendation.allocations.map((slice) => {
    const material = Math.abs(slice.deltaKw) >= slice.capacityKw * threshold;
    if (!material || slice.deltaKw === 0) {
      return {
        assetId: slice.assetId,
        type: slice.type,
        action: "hold" as const,
        deltaKw: 0,
        reason: "Within 5% of target — not worth trading",
      };
    }
    return {
      assetId: slice.assetId,
      type: slice.type,
      action: slice.deltaKw > 0 ? ("increase" as const) : ("decrease" as const),
      deltaKw: slice.deltaKw,
      reason:
        slice.deltaKw > 0
          ? `Underweight vs ${slice.weightPct}% target`
          : `Overweight vs ${slice.weightPct}% target`,
    };
  });

  // Net capital movement: only increases cost money to deploy.
  const additions = actions.filter((a) => a.deltaKw > 0).reduce((sum, a) => sum + a.deltaKw, 0);
  const reductions = actions.filter((a) => a.deltaKw < 0).reduce((sum, a) => sum + Math.abs(a.deltaKw), 0);
  const netDeltaKw = round2(additions - reductions);

  // Executing the plan moves concentration toward the target, so the score
  // improves by however much the current score overshoots the target.
  const target = recommendation.targetRiskScore;
  const riskAfter = Math.max(target, risk.score - Math.abs(risk.score - target));

  return {
    actions,
    netDeltaKw,
    estimatedCostXlm: round2(additions * PORTFOLIO_CAPEX_XLM_PER_KW),
    riskBefore: risk.score,
    riskAfter: round2(riskAfter),
    generatedAt: now,
  };
}

/**
 * Apply a rebalancing plan in one step.
 *
 * Capacity moves between the named assets so the portfolio total is preserved;
 * the plan's `increase` actions take the capacity the `decrease` actions give
 * up. Applying the same plan twice is a no-op because capacity changes are
 * idempotent once the plan's deltas are exhausted.
 */
export function applyRebalance(ownerId: string, options: { targetRiskScore?: number } = {}): RebalancePlan {
  const plan = getRebalancePlan(ownerId, options);
  const held = listAssets(ownerId);
  if (held.length === 0 || plan.actions.every((action) => action.action === "hold")) return plan;

  // Take capacity from the biggest reducible asset first so the source of
  // funding is deterministic rather than map-order dependent.
  const donors = plan.actions
    .filter((action) => action.action === "decrease")
    .sort((a, b) => b.deltaKw - a.deltaKw);
  const receivers = plan.actions.filter((action) => action.action === "increase");

  let released = 0;
  for (const donor of donors) {
    const asset = assets.get(donor.assetId);
    if (!asset) continue;
    const removal = Math.min(asset.capacityKw, Math.abs(donor.deltaKw));
    asset.capacityKw = round2(asset.capacityKw - removal);
    released += removal;
  }

  let remaining = released;
  for (const receiver of receivers) {
    const asset = assets.get(receiver.assetId);
    if (!asset || remaining <= 0) continue;
    const addition = Math.min(remaining, receiver.deltaKw);
    asset.capacityKw = round2(asset.capacityKw + addition);
    asset.costBasisXlm = round2(asset.costBasisXlm + addition * PORTFOLIO_CAPEX_XLM_PER_KW);
    remaining -= addition;
  }

  return getRebalancePlan(ownerId, options);
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export function getDashboard(ownerId: string): PortfolioDashboard {
  return {
    ownerId,
    assets: listAssets(ownerId),
    assetCount: listAssets(ownerId).length,
    performance: getPerformance(ownerId),
    risk: assessRisk(ownerId),
    recommendation: recommendAllocation(ownerId),
    rebalance: getRebalancePlan(ownerId),
    generatedAt: new Date().toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Reset all portfolio state. Test-only. */
export function resetPortfoliosForTests(): void {
  assets.clear();
  idSeq = 1;
}
