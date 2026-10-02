// #889: Energy load balancing — priority-aware, cost-optimised load shedding/shifting.

export type LoadPriority = "critical" | "high" | "normal" | "deferrable";

export interface Load {
  id: string;
  demandKw: number;
  priority: LoadPriority;
  /** User override: "on" forces the load on, "off" forces it off. */
  override?: "on" | "off";
}

export interface BalanceInput {
  loads: Load[];
  capacityKw: number;
  /** Current tariff per kWh. */
  pricePerKwh: number;
  /** Tariff above which deferrable loads are shifted. */
  peakPriceThreshold?: number;
}

export interface BalanceResult {
  on: string[];
  off: string[];
  servedKw: number;
  shedKw: number;
  baselineCost: number;
  optimisedCost: number;
  savingsPct: number;
}

const RANK: Record<LoadPriority, number> = { critical: 0, high: 1, normal: 2, deferrable: 3 };

export function balanceLoads({ loads, capacityKw, pricePerKwh, peakPriceThreshold = Infinity }: BalanceInput): BalanceResult {
  const on: string[] = [];
  const off: string[] = [];
  let used = 0;

  const forcedOn = loads.filter((l) => l.override === "on");
  const auto = loads.filter((l) => !l.override).sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.demandKw - b.demandKw);

  for (const l of forcedOn) { on.push(l.id); used += l.demandKw; }
  for (const l of loads) if (l.override === "off") off.push(l.id);

  const peak = pricePerKwh >= peakPriceThreshold;
  for (const l of auto) {
    const shift = peak && l.priority === "deferrable";
    // Critical loads are always served, even beyond nominal capacity.
    if (!shift && (l.priority === "critical" || used + l.demandKw <= capacityKw)) {
      on.push(l.id); used += l.demandKw;
    } else {
      off.push(l.id);
    }
  }

  const totalKw = loads.reduce((s, l) => s + l.demandKw, 0);
  const baselineCost = totalKw * pricePerKwh;
  const optimisedCost = used * pricePerKwh;
  return {
    on, off,
    servedKw: used,
    shedKw: totalKw - used,
    baselineCost,
    optimisedCost,
    savingsPct: baselineCost ? +(((baselineCost - optimisedCost) / baselineCost) * 100).toFixed(2) : 0,
  };
}
