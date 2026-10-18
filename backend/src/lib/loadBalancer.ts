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
  /**
   * #1063: Swarm-derived strategy weights shared across meters.
   * Values are normalised 0..1 and bias shedding/shifting decisions so that
   * meters collectively converge on an emergent, decentralised balance.
   */
  swarmWeights?: SwarmWeights;
}

/**
 * #1063: Anonymised, network-wide strategy weights learned collectively by
 * the meter swarm. Each weight is a 0..1 confidence in a given behaviour.
 */
export interface SwarmWeights {
  /** Confidence that deferrable loads should be shifted during peaks. */
  shiftDeferrable: number;
  /** Confidence that normal loads should be shed when capacity is tight. */
  shedNormal: number;
  /** Confidence that high-priority loads should be shed as a last resort. */
  shedHigh: number;
  /** Confidence that spare capacity should be reserved for critical loads. */
  reserveCritical: number;
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

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** #1063: Neutral swarm weights — behave exactly like the non-swarm balancer. */
export const NEUTRAL_SWARM_WEIGHTS: SwarmWeights = {
  shiftDeferrable: 0,
  shedNormal: 0,
  shedHigh: 0,
  reserveCritical: 0,
};

function normaliseSwarmWeights(w?: SwarmWeights): SwarmWeights {
  if (!w) return NEUTRAL_SWARM_WEIGHTS;
  return {
    shiftDeferrable: clamp01(w.shiftDeferrable),
    shedNormal: clamp01(w.shedNormal),
    shedHigh: clamp01(w.shedHigh),
    reserveCritical: clamp01(w.reserveCritical),
  };
}

export function balanceLoads({ loads, capacityKw, pricePerKwh, peakPriceThreshold = Infinity, swarmWeights }: BalanceInput): BalanceResult {
  const on: string[] = [];
  const off: string[] = [];
  let used = 0;

  const swarm = normaliseSwarmWeights(swarmWeights);

  const forcedOn = loads.filter((l) => l.override === "on");
  const auto = loads.filter((l) => !l.override).sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.demandKw - b.demandKw);

  for (const l of forcedOn) { on.push(l.id); used += l.demandKw; }
  for (const l of loads) if (l.override === "off") off.push(l.id);

  // #1063: Emergent load balancing — the swarm can lower the effective
  // capacity available to non-critical loads to reserve headroom for critical
  // ones, and can raise it when the collective agrees shedding is unnecessary.
  const reserveKw = capacityKw * swarm.reserveCritical * 0.25;
  const effectiveCapacity = capacityKw - reserveKw;

  const peak = pricePerKwh >= peakPriceThreshold;
  for (const l of auto) {
    // #1063: Swarm bias — deferrable loads shift on peaks, and the collective
    // confidence can also trigger shifting slightly below the peak threshold.
    const shiftBias = peak || swarm.shiftDeferrable > 0.5;
    const shift = shiftBias && l.priority === "deferrable";

    // #1063: Swarm can proactively shed normal/high loads when the network
    // collectively signals congestion, even if local capacity allows them.
    const shedBySwarm =
      (l.priority === "normal" && swarm.shedNormal > 0.75) ||
      (l.priority === "high" && swarm.shedHigh > 0.9);

    // Critical loads are always served, even beyond nominal capacity.
    if (!shift && !shedBySwarm && (l.priority === "critical" || used + l.demandKw <= effectiveCapacity)) {
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
