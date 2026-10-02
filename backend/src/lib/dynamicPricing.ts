/**
 * Dynamic pricing engine (#877).
 *
 * Prices are recalculated every 15 minutes based on supply/demand ratio and
 * time-of-day. Prices are capped to prevent extreme swings.
 */

export type PriceTier = "off-peak" | "standard" | "peak";

export type PricePoint = {
  timestamp: string;
  pricePerKwh: number;
  tier: PriceTier;
  supplyKwh: number;
  demandKwh: number;
  supplyDemandRatio: number;
};

export type PricingConfig = {
  basePrice: number;
  peakMultiplier: number;
  offPeakMultiplier: number;
  maxPrice: number;
  minPrice: number;
  peakHours: number[];
  offPeakHours: number[];
  intervalMs: number;
};

const DEFAULT_CONFIG: PricingConfig = {
  basePrice: 0.12,
  peakMultiplier: 1.8,
  offPeakMultiplier: 0.6,
  maxPrice: 0.5,
  minPrice: 0.03,
  peakHours: [7, 8, 9, 17, 18, 19, 20],
  offPeakHours: [0, 1, 2, 3, 4, 5, 23],
  intervalMs: 15 * 60 * 1000,
};

let config: PricingConfig = { ...DEFAULT_CONFIG };

const priceHistory: PricePoint[] = [];
const MAX_HISTORY = 672; // 7 days × 96 intervals/day

let currentPrice: PricePoint | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;

export function getTier(hour: number): PriceTier {
  if (config.peakHours.includes(hour)) return "peak";
  if (config.offPeakHours.includes(hour)) return "off-peak";
  return "standard";
}

export function calculatePrice(supplyKwh: number, demandKwh: number, now = new Date()): PricePoint {
  const hour = now.getUTCHours();
  const tier = getTier(hour);

  const tierMultiplier =
    tier === "peak"
      ? config.peakMultiplier
      : tier === "off-peak"
        ? config.offPeakMultiplier
        : 1.0;

  const ratio = supplyKwh > 0 ? demandKwh / supplyKwh : 2.0;
  // Demand pressure: price rises when demand > supply, falls when supply > demand
  const demandMultiplier = Math.max(0.5, Math.min(2.0, ratio));

  const rawPrice = config.basePrice * tierMultiplier * demandMultiplier;
  const pricePerKwh = Math.max(config.minPrice, Math.min(config.maxPrice, rawPrice));

  return {
    timestamp: now.toISOString(),
    pricePerKwh: Number(pricePerKwh.toFixed(4)),
    tier,
    supplyKwh,
    demandKwh,
    supplyDemandRatio: Number(ratio.toFixed(4)),
  };
}

export function recordPrice(point: PricePoint): void {
  priceHistory.push(point);
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
  currentPrice = point;
}

export function getCurrentPrice(): PricePoint | null {
  return currentPrice;
}

export function getPriceHistory(limit = 96): PricePoint[] {
  return priceHistory.slice(-Math.min(limit, MAX_HISTORY));
}

export function updatePricingConfig(partial: Partial<PricingConfig>): PricingConfig {
  config = { ...config, ...partial };
  return config;
}

export function getPricingConfig(): PricingConfig {
  return { ...config };
}

export function predictPrice(hoursAhead: number, baseSupply = 100, baseDemand = 100): PricePoint[] {
  const predictions: PricePoint[] = [];
  const now = new Date();
  for (let i = 1; i <= hoursAhead; i++) {
    const future = new Date(now.getTime() + i * 60 * 60 * 1000);
    const hour = future.getUTCHours();
    const tier = getTier(hour);
    // Simple heuristic: demand is higher during peak hours
    const demandFactor = tier === "peak" ? 1.3 : tier === "off-peak" ? 0.7 : 1.0;
    predictions.push(calculatePrice(baseSupply, baseDemand * demandFactor, future));
  }
  return predictions;
}

export function startPricingScheduler(getMetrics?: () => { supplyKwh: number; demandKwh: number }): void {
  if (schedulerTimer) return;

  const tick = () => {
    const metrics = getMetrics ? getMetrics() : { supplyKwh: 100, demandKwh: 100 };
    const point = calculatePrice(metrics.supplyKwh, metrics.demandKwh);
    recordPrice(point);
  };

  tick();
  schedulerTimer = setInterval(tick, config.intervalMs);
}

export function stopPricingScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
