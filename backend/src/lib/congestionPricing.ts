/**
 * Grid congestion pricing (#937).
 *
 * Congestion level = load / capacity per zone. Price multiplier rises linearly
 * once load passes CONGESTION_THRESHOLD, capped at MAX_MULTIPLIER. Forecasts
 * extrapolate the recent load trend (least-squares slope) 4 hours ahead.
 */
import { sendPushToOwner } from "./pushNotifications.js";
import { logger } from "./logger.js";

export const CONGESTION_THRESHOLD = Number(process.env.CONGESTION_THRESHOLD ?? 0.7);
export const MAX_MULTIPLIER = Number(process.env.CONGESTION_MAX_MULTIPLIER ?? 3);
export const FORECAST_HORIZON_HOURS = 4;
const HISTORY_LIMIT = 288;
const MIN_NOTIFY_DELTA = 0.1;

export type LoadSample = { at: number; load: number };
export type ZoneState = {
  zone: string;
  capacity: number;
  load: number;
  utilization: number;
  congested: boolean;
  multiplier: number;
  updatedAt: string;
};

const capacities = new Map<string, number>();
const history = new Map<string, LoadSample[]>();
const states = new Map<string, ZoneState>();
const subscribers = new Map<string, Set<string>>();
const lastNotified = new Map<string, number>();

/** Price multiplier for a utilization ratio: 1 below threshold, linear up to MAX_MULTIPLIER at 100%. */
export function priceMultiplier(utilization: number): number {
  if (utilization <= CONGESTION_THRESHOLD) return 1;
  const span = Math.max(1 - CONGESTION_THRESHOLD, 1e-9);
  const t = Math.min((utilization - CONGESTION_THRESHOLD) / span, 1);
  return Number((1 + t * (MAX_MULTIPLIER - 1)).toFixed(4));
}

export function setZoneCapacity(zone: string, capacity: number): void {
  capacities.set(zone, capacity);
}

/** Record a real-time load reading; returns the updated zone state and notifies subscribers on big price moves. */
export function recordLoad(zone: string, load: number, at = Date.now()): ZoneState {
  const capacity = capacities.get(zone);
  if (!capacity) throw new Error(`Unknown zone or capacity not set: ${zone}`);
  const samples = history.get(zone) ?? [];
  samples.push({ at, load });
  if (samples.length > HISTORY_LIMIT) samples.shift();
  history.set(zone, samples);

  const utilization = load / capacity;
  const state: ZoneState = {
    zone,
    capacity,
    load,
    utilization: Number(utilization.toFixed(4)),
    congested: utilization > CONGESTION_THRESHOLD,
    multiplier: priceMultiplier(utilization),
    updatedAt: new Date(at).toISOString(),
  };
  states.set(zone, state);
  notifyIfChanged(state);
  return state;
}

/** Forecast utilization for each of the next 4 hours using a linear trend over recent samples. */
export function forecastZone(zone: string, now = Date.now()) {
  const capacity = capacities.get(zone);
  const samples = history.get(zone) ?? [];
  if (!capacity || samples.length < 2) return [];
  const n = samples.length;
  const xs = samples.map((s) => (s.at - samples[0].at) / 3_600_000);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = samples.reduce((a, s) => a + s.load, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (samples[i].load - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const originX = (now - samples[0].at) / 3_600_000;
  return Array.from({ length: FORECAST_HORIZON_HOURS }, (_, i) => {
    const h = i + 1;
    const load = Math.max(0, meanY + slope * (originX + h - meanX));
    const utilization = load / capacity;
    return {
      at: new Date(now + h * 3_600_000).toISOString(),
      predictedLoad: Number(load.toFixed(2)),
      utilization: Number(utilization.toFixed(4)),
      congested: utilization > CONGESTION_THRESHOLD,
      multiplier: priceMultiplier(utilization),
    };
  });
}

export function getZoneState(zone: string): ZoneState | undefined {
  return states.get(zone);
}

export function listZoneStates(): ZoneState[] {
  return [...states.values()];
}

/** Effective per-unit price after congestion adjustment. */
export function adjustedPrice(zone: string, basePrice: number): number {
  return Number((basePrice * (states.get(zone)?.multiplier ?? 1)).toFixed(7));
}

export function subscribeToZone(zone: string, ownerAddress: string): void {
  const set = subscribers.get(zone) ?? new Set<string>();
  set.add(ownerAddress);
  subscribers.set(zone, set);
}

export function unsubscribeFromZone(zone: string, ownerAddress: string): void {
  subscribers.get(zone)?.delete(ownerAddress);
}

function notifyIfChanged(state: ZoneState): void {
  const prev = lastNotified.get(state.zone) ?? 1;
  if (Math.abs(state.multiplier - prev) < MIN_NOTIFY_DELTA) return;
  lastNotified.set(state.zone, state.multiplier);
  const direction = state.multiplier > prev ? "increased" : "decreased";
  for (const owner of subscribers.get(state.zone) ?? []) {
    sendPushToOwner(owner, {
      title: "Energy price update",
      body: `Grid price in ${state.zone} ${direction} to ${state.multiplier}x (load ${Math.round(state.utilization * 100)}%).`,
      tag: `congestion-${state.zone}`,
    }).catch((err) => logger.warn({ err }, "congestion notification failed"));
  }
}

/** Test helper. */
export function resetCongestionState(): void {
  capacities.clear();
  history.clear();
  states.clear();
  subscribers.clear();
  lastNotified.clear();
}
