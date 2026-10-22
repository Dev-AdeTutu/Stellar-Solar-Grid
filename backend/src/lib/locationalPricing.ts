/**
 * Real-time locational marginal pricing (#1057).
 *
 * LMP per region = energy + congestion + loss components:
 *   energy     = system base price
 *   congestion = base × (zone congestion multiplier − 1)   (from congestionPricing)
 *   loss       = base × lossFactor                         (distance from generation)
 * Prices are recomputed every PRICING_INTERVAL_MS (default 5 min); subscribers
 * of a region get a push notification when its price moves ≥ NOTIFY_DELTA_PCT.
 */
import { getZoneState } from "./congestionPricing.js";
import { sendPushToOwner } from "./pushNotifications.js";
import { logger } from "./logger.js";

export const PRICING_INTERVAL_MS = Number(process.env.PRICING_INTERVAL_MS ?? 5 * 60_000);
export const NOTIFY_DELTA_PCT = Number(process.env.PRICING_NOTIFY_DELTA_PCT ?? 5);

export type Region = { region: string; zone: string; lossFactor: number; lat?: number; lng?: number };
export type RegionPrice = {
  region: string;
  zone: string;
  energy: number;
  congestion: number;
  loss: number;
  price: number;
  utilization: number;
  lat?: number;
  lng?: number;
  updatedAt: string;
};

let basePrice = Number(process.env.LMP_BASE_PRICE ?? 0.1);
const regions = new Map<string, Region>();
const prices = new Map<string, RegionPrice>();
const subscribers = new Map<string, Set<string>>();
let timer: NodeJS.Timeout | undefined;

const round = (n: number) => Number(n.toFixed(7));

export function setBasePrice(price: number): void {
  basePrice = price;
}

export function upsertRegion(region: Region): void {
  regions.set(region.region, region);
}

export function computeRegionPrice(region: Region, now = new Date()): RegionPrice {
  const zone = getZoneState(region.zone);
  const multiplier = zone?.multiplier ?? 1;
  const energy = basePrice;
  const congestion = basePrice * (multiplier - 1);
  const loss = basePrice * region.lossFactor;
  return {
    region: region.region,
    zone: region.zone,
    energy: round(energy),
    congestion: round(congestion),
    loss: round(loss),
    price: round(energy + congestion + loss),
    utilization: zone?.utilization ?? 0,
    lat: region.lat,
    lng: region.lng,
    updatedAt: now.toISOString(),
  };
}

/** Recompute every region's LMP and notify on significant changes. Returns the new prices. */
export function repriceAll(now = new Date()): RegionPrice[] {
  const out: RegionPrice[] = [];
  for (const region of regions.values()) {
    const next = computeRegionPrice(region, now);
    const prev = prices.get(region.region);
    prices.set(region.region, next);
    if (prev && prev.price > 0) {
      const pct = ((next.price - prev.price) / prev.price) * 100;
      if (Math.abs(pct) >= NOTIFY_DELTA_PCT) notify(next, pct);
    }
    out.push(next);
  }
  return out;
}

function notify(p: RegionPrice, pct: number): void {
  const direction = pct > 0 ? "rose" : "fell";
  for (const owner of subscribers.get(p.region) ?? []) {
    sendPushToOwner(owner, {
      title: "Grid price change",
      body: `Price in ${p.region} ${direction} ${Math.abs(pct).toFixed(1)}% to ${p.price} XLM/kWh.`,
      tag: `lmp-${p.region}`,
    }).catch((err) => logger.warn({ err }, "LMP notification failed"));
  }
}

export const listPrices = () => [...prices.values()];
export const getPrice = (region: string) => prices.get(region);

/** Heatmap payload: prices normalised to 0..1 intensity across regions. */
export function heatmap() {
  const list = listPrices();
  const min = Math.min(...list.map((p) => p.price));
  const max = Math.max(...list.map((p) => p.price));
  const span = max - min || 1;
  return list.map((p) => ({ ...p, intensity: list.length > 1 ? Number(((p.price - min) / span).toFixed(4)) : 0 }));
}

export function subscribeToRegion(region: string, owner: string): void {
  const set = subscribers.get(region) ?? new Set<string>();
  set.add(owner);
  subscribers.set(region, set);
}

export function unsubscribeFromRegion(region: string, owner: string): void {
  subscribers.get(region)?.delete(owner);
}

export function startLocationalPricing(): void {
  if (timer) return;
  timer = setInterval(() => repriceAll(), PRICING_INTERVAL_MS);
  timer.unref?.();
}

export function stopLocationalPricing(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Test helper. */
export function resetLocationalPricing(): void {
  stopLocationalPricing();
  regions.clear();
  prices.clear();
  subscribers.clear();
  basePrice = Number(process.env.LMP_BASE_PRICE ?? 0.1);
}
