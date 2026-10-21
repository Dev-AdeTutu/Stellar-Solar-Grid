/**
 * Energy storage optimization AI (#1053). See backend/AI_OPTIMIZATION.md.
 *
 * A tabular Q-learning agent learns when to charge, discharge or idle a
 * battery given hour-of-day, state-of-charge bucket, price level and solar
 * forecast. Reward is cost savings plus a grid-independence bonus. Savings
 * are tracked against a no-battery baseline.
 */

export type Action = "charge" | "discharge" | "idle";
export const ACTIONS: Action[] = ["charge", "discharge", "idle"];

export interface Battery {
  capacityKwh: number;
  maxRateKw: number;
  efficiency: number;
  socKwh: number;
}

export interface HourInput {
  hour: number;
  pricePerKwh: number;
  solarKwh: number;
  loadKwh: number;
}

export interface StepResult {
  hour: number;
  action: Action;
  socKwh: number;
  gridImportKwh: number;
  cost: number;
  baselineCost: number;
}

export interface OptimizerConfig {
  alpha: number;
  gamma: number;
  epsilon: number;
  /** Reward bonus per kWh of grid import avoided. */
  independenceWeight: number;
}

export const DEFAULT_CONFIG: OptimizerConfig = { alpha: 0.2, gamma: 0.9, epsilon: 0.1, independenceWeight: 0.02 };

const SOC_BUCKETS = 5;

export function priceLevel(price: number, prices: number[]): number {
  const sorted = [...prices].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length / 3)] ?? price;
  const hi = sorted[Math.floor((2 * sorted.length) / 3)] ?? price;
  return price < lo ? 0 : price >= hi ? 2 : 1;
}

export function stateKey(input: HourInput, battery: Battery, prices: number[]): string {
  const soc = Math.min(SOC_BUCKETS - 1, Math.floor((battery.socKwh / battery.capacityKwh) * SOC_BUCKETS));
  const surplus = input.solarKwh > input.loadKwh ? 1 : 0;
  return `${input.hour}|${soc}|${priceLevel(input.pricePerKwh, prices)}|${surplus}`;
}

/** Apply one hour of an action to the battery; returns the new battery and step accounting. */
export function step(battery: Battery, input: HourInput, action: Action): { battery: Battery; result: StepResult } {
  const net = input.loadKwh - input.solarKwh;
  let soc = battery.socKwh;
  let gridImport = net;
  if (action === "charge") {
    const room = (battery.capacityKwh - soc) / battery.efficiency;
    const draw = Math.min(battery.maxRateKw, room);
    soc += draw * battery.efficiency;
    gridImport += draw;
  } else if (action === "discharge") {
    const deliver = Math.min(battery.maxRateKw, soc * battery.efficiency, Math.max(0, net));
    soc -= deliver / battery.efficiency;
    gridImport -= deliver;
  }
  // Excess solar is stored for free when there's room.
  if (gridImport < 0) {
    const stored = Math.min(-gridImport * battery.efficiency, battery.capacityKwh - soc);
    soc += stored;
    gridImport = 0;
  }
  const cost = gridImport * input.pricePerKwh;
  const baselineCost = Math.max(0, net) * input.pricePerKwh;
  return {
    battery: { ...battery, socKwh: soc },
    result: { hour: input.hour, action, socKwh: round3(soc), gridImportKwh: round3(gridImport), cost: round3(cost), baselineCost: round3(baselineCost) },
  };
}

export class StorageAgent {
  readonly q = new Map<string, number[]>();
  constructor(readonly config: OptimizerConfig = DEFAULT_CONFIG, private rng: () => number = Math.random) {}

  private values(key: string): number[] {
    let v = this.q.get(key);
    if (!v) {
      v = [0, 0, 0];
      this.q.set(key, v);
    }
    return v;
  }

  greedy(key: string): Action {
    const v = this.values(key);
    let best = 0;
    for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i;
    return ACTIONS[best];
  }

  /** Train over repeated episodes of a day profile. */
  train(day: HourInput[], initial: Battery, episodes = 500): void {
    const prices = day.map((d) => d.pricePerKwh);
    for (let e = 0; e < episodes; e++) {
      let battery = { ...initial };
      for (let i = 0; i < day.length; i++) {
        const key = stateKey(day[i], battery, prices);
        const a = this.rng() < this.config.epsilon ? ACTIONS[Math.floor(this.rng() * ACTIONS.length)] : this.greedy(key);
        const { battery: next, result } = step(battery, day[i], a);
        const reward = result.baselineCost - result.cost + this.config.independenceWeight * (Math.max(0, day[i].loadKwh - day[i].solarKwh) - result.gridImportKwh);
        const nextMax = i + 1 < day.length ? Math.max(...this.values(stateKey(day[i + 1], next, prices))) : 0;
        const v = this.values(key);
        const ai = ACTIONS.indexOf(a);
        v[ai] += this.config.alpha * (reward + this.config.gamma * nextMax - v[ai]);
        battery = next;
      }
    }
  }

  /** Run the greedy policy, emitting real-time control signals and savings vs baseline. */
  plan(day: HourInput[], initial: Battery): { schedule: StepResult[]; totalCost: number; baselineCost: number; savings: number; gridIndependence: number } {
    const prices = day.map((d) => d.pricePerKwh);
    let battery = { ...initial };
    const schedule: StepResult[] = [];
    for (const input of day) {
      const { battery: next, result } = step(battery, input, this.greedy(stateKey(input, battery, prices)));
      schedule.push(result);
      battery = next;
    }
    return summarize(schedule, day);
  }
}

export function summarize(schedule: StepResult[], day: HourInput[]) {
  const totalCost = schedule.reduce((s, r) => s + r.cost, 0);
  const baselineCost = schedule.reduce((s, r) => s + r.baselineCost, 0);
  const load = day.reduce((s, d) => s + d.loadKwh, 0);
  const imported = schedule.reduce((s, r) => s + r.gridImportKwh, 0);
  return {
    schedule,
    totalCost: round3(totalCost),
    baselineCost: round3(baselineCost),
    savings: round3(baselineCost - totalCost),
    gridIndependence: load > 0 ? round3(1 - imported / load) : 1,
  };
}

/** Deterministic PRNG so training is reproducible in tests and API responses. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
