/**
 * Predictive grid capacity planning (#1050). See docs/CAPACITY_PLANNING.md.
 *
 * Fits a least-squares linear trend over monthly per-region observations
 * (active meters, peak demand), projects capacity needs, flags bottlenecks
 * and produces investment recommendations under growth scenarios.
 */

export interface RegionObservation {
  region: string;
  /** ISO month, e.g. "2026-01". */
  month: string;
  meters: number;
  peakKw: number;
}

export interface TrendFit {
  slope: number;
  intercept: number;
  r2: number;
}

export interface RegionForecast {
  region: string;
  capacityKw: number;
  meterTrend: TrendFit;
  peakTrend: TrendFit;
  monthlyGrowthRate: number;
  projections: { monthOffset: number; meters: number; peakKw: number; utilization: number }[];
  bottleneckInMonths: number | null;
}

export interface Recommendation {
  region: string;
  priority: "critical" | "high" | "medium" | "low";
  additionalKw: number;
  estimatedCost: number;
  reason: string;
}

export const SCENARIOS = { conservative: 0.5, baseline: 1, aggressive: 1.75 } as const;
export type Scenario = keyof typeof SCENARIOS;

/** Utilization above which a region is considered a bottleneck. */
export const BOTTLENECK_UTILIZATION = 0.85;
/** Planning cost per kW of new capacity (USD). */
export const COST_PER_KW = 1_200;

const observations = new Map<string, RegionObservation[]>();
const capacities = new Map<string, number>();

export function recordObservation(obs: RegionObservation): RegionObservation {
  const list = observations.get(obs.region) ?? [];
  const idx = list.findIndex((o) => o.month === obs.month);
  if (idx >= 0) list[idx] = obs;
  else list.push(obs);
  list.sort((a, b) => a.month.localeCompare(b.month));
  observations.set(obs.region, list);
  return obs;
}

export function setCapacity(region: string, capacityKw: number): void {
  capacities.set(region, capacityKw);
}

export function listRegions(): string[] {
  return [...new Set([...observations.keys(), ...capacities.keys()])].sort();
}

export function resetCapacityPlanning(): void {
  observations.clear();
  capacities.clear();
}

/** Ordinary least squares fit of ys against x = 0..n-1. */
export function linearFit(ys: number[]): TrendFit {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0], r2: 1 };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, x) => {
    sxy += (x - meanX) * (y - meanY);
    sxx += (x - meanX) ** 2;
  });
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  ys.forEach((y, x) => {
    ssRes += (y - (intercept + slope * x)) ** 2;
    ssTot += (y - meanY) ** 2;
  });
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

export function forecastRegion(region: string, horizonMonths = 24, scenario: Scenario = "baseline"): RegionForecast {
  const obs = observations.get(region) ?? [];
  const capacityKw = capacities.get(region) ?? 0;
  const meterTrend = linearFit(obs.map((o) => o.meters));
  const peakTrend = linearFit(obs.map((o) => o.peakKw));
  const multiplier = SCENARIOS[scenario];
  const last = obs.length - 1;
  const lastPeak = obs.length ? peakTrend.intercept + peakTrend.slope * last : 0;
  const monthlyGrowthRate = lastPeak > 0 ? (peakTrend.slope * multiplier) / lastPeak : 0;

  const projections = [];
  let bottleneckInMonths: number | null = null;
  for (let m = 1; m <= horizonMonths; m++) {
    const meters = Math.max(0, meterTrend.intercept + meterTrend.slope * (last + m * multiplier));
    const peakKw = Math.max(0, lastPeak + peakTrend.slope * multiplier * m);
    const utilization = capacityKw > 0 ? peakKw / capacityKw : 0;
    if (bottleneckInMonths === null && capacityKw > 0 && utilization >= BOTTLENECK_UTILIZATION) bottleneckInMonths = m;
    projections.push({ monthOffset: m, meters: Math.round(meters), peakKw: round2(peakKw), utilization: round2(utilization) });
  }
  return { region, capacityKw, meterTrend, peakTrend, monthlyGrowthRate, projections, bottleneckInMonths };
}

export function recommendInvestments(horizonMonths = 24, scenario: Scenario = "baseline"): Recommendation[] {
  return listRegions()
    .map((region) => forecastRegion(region, horizonMonths, scenario))
    .filter((f) => f.bottleneckInMonths !== null)
    .map((f) => {
      const finalPeak = f.projections[f.projections.length - 1].peakKw;
      const additionalKw = Math.max(0, Math.ceil(finalPeak / BOTTLENECK_UTILIZATION - f.capacityKw));
      const months = f.bottleneckInMonths!;
      const priority: Recommendation["priority"] = months <= 3 ? "critical" : months <= 6 ? "high" : months <= 12 ? "medium" : "low";
      return {
        region: f.region,
        priority,
        additionalKw,
        estimatedCost: additionalKw * COST_PER_KW,
        reason: `Projected to exceed ${BOTTLENECK_UTILIZATION * 100}% utilization in ${months} month(s) under ${scenario} growth`,
      };
    })
    .sort((a, b) => b.additionalKw - a.additionalKw);
}

/** Mean absolute percentage error of a hold-out backtest: fit on all but the last `holdout` points. */
export function backtestAccuracy(region: string, holdout = 3): { mape: number; points: number } {
  const peaks = (observations.get(region) ?? []).map((o) => o.peakKw);
  if (peaks.length <= holdout + 1) return { mape: NaN, points: 0 };
  const train = peaks.slice(0, peaks.length - holdout);
  const fit = linearFit(train);
  const errs = peaks.slice(-holdout).map((actual, i) => {
    const pred = fit.intercept + fit.slope * (train.length + i);
    return actual === 0 ? 0 : Math.abs(actual - pred) / actual;
  });
  return { mape: round2((errs.reduce((a, b) => a + b, 0) / errs.length) * 100), points: holdout };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
