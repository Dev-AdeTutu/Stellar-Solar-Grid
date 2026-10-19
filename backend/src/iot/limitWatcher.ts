import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarService } from '../lib/stellar.js';
import { getMqttClient } from './mqttClient.js';
import { logger } from '../lib/logger.js';
import { listDevices, listPerformance } from '../lib/deviceRegistry.js';

const THRESHOLD = 0.8;
const warnedToday = new Set<string>();

// Network congestion management (#906)
const CONGESTION_THRESHOLD = Number(process.env.CONGESTION_THRESHOLD ?? 0.85);
const CONGESTION_CLEAR_THRESHOLD = Number(process.env.CONGESTION_CLEAR_THRESHOLD ?? 0.7);
const CONGESTION_PEAK_MULTIPLIER = Number(process.env.CONGESTION_PEAK_MULTIPLIER ?? 1.5);
const CONGESTION_SHED_RATIO = Number(process.env.CONGESTION_SHED_RATIO ?? 0.5);

let congested = false;
const congestionHistory: Array<{ at: string; load: number; congested: boolean }> = [];

// Energy storage optimization (#907)
const STORAGE_MIN_SOC = Number(process.env.STORAGE_MIN_SOC ?? 0.2);
const STORAGE_MAX_SOC = Number(process.env.STORAGE_MAX_SOC ?? 0.9);
const STORAGE_MAX_CYCLES = Number(process.env.STORAGE_MAX_CYCLES ?? 5000);
const STORAGE_DEGRADE_PER_CYCLE = Number(process.env.STORAGE_DEGRADE_PER_CYCLE ?? 0.00002);
const STORAGE_ROUND_TRIP_EFFICIENCY = Number(process.env.STORAGE_ROUND_TRIP_EFFICIENCY ?? 0.9);
const STORAGE_PRICE_HORIZON = Number(process.env.STORAGE_PRICE_HORIZON ?? 24);

interface StorageState {
  soc: number;
  capacityKwh: number;
  cycles: number;
  health: number;
  lastPrice: number;
  savings: number;
  baselineCost: number;
  optimizedCost: number;
  automationEnabled: boolean;
}

const storageStates = new Map<string, StorageState>();
const storageMetrics: Array<{ at: string; batteryId: string; action: string; soc: number; savings: number }> = [];

function getStorageState(batteryId: string, meter: any): StorageState {
  let state = storageStates.get(batteryId);
  if (!state) {
    state = {
      soc: Number(meter.soc ?? 0.5),
      capacityKwh: Number(meter.battery_capacity ?? meter.capacity ?? 10),
      cycles: Number(meter.cycles ?? 0),
      health: Number(meter.health ?? 1),
      lastPrice: Number(meter.price ?? 0),
      savings: 0,
      baselineCost: 0,
      optimizedCost: 0,
      automationEnabled: meter.automation_enabled !== false,
    };
    storageStates.set(batteryId, state);
  }
  return state;
}

/**
 * Predict the near-term price curve from recent price history. Uses a simple
 * moving-average trend so charge/discharge decisions can be made ahead of peaks.
 */
export function predictPrices(history: number[], horizon = STORAGE_PRICE_HORIZON): number[] {
  if (history.length === 0) return new Array(horizon).fill(0);
  const window = history.slice(-Math.min(history.length, 6));
  const avg = window.reduce((a, b) => a + b, 0) / window.length;
  const trend = window.length > 1 ? (window[window.length - 1] - window[0]) / window.length : 0;
  const predicted: number[] = [];
  for (let i = 0; i < horizon; i++) {
    predicted.push(Math.max(0, avg + trend * (i + 1)));
  }
  return predicted;
}

/**
 * Decide whether to charge, discharge, or hold based on predicted prices,
 * battery health, and state-of-charge limits. Returns the chosen action.
 */
export function optimizeStorageCycle(state: StorageState, predicted: number[]): 'CHARGE' | 'DISCHARGE' | 'HOLD' {
  if (!state.automationEnabled) return 'HOLD';
  if (state.health <= 0 || state.cycles >= STORAGE_MAX_CYCLES) return 'HOLD';

  const current = state.lastPrice;
  const future = predicted.length ? predicted : [current];
  const maxFuture = Math.max(...future);
  const minFuture = Math.min(...future);

  // Charge when current price is near the low end and there is headroom.
  if (current <= minFuture * 1.05 && state.soc < STORAGE_MAX_SOC) return 'CHARGE';
  // Discharge when current price is near the high end and there is energy stored.
  if (current >= maxFuture * 0.95 && state.soc > STORAGE_MIN_SOC) return 'DISCHARGE';
  return 'HOLD';
}

export function chooseRegisteredStorageAction(
  stateOfCharge: number,
  currentPrice: number,
  chargePriceBelow: number,
  dischargePriceAbove: number,
): 'CHARGE' | 'DISCHARGE' | 'HOLD' {
  if (stateOfCharge < STORAGE_MAX_SOC && currentPrice <= chargePriceBelow) return 'CHARGE';
  if (stateOfCharge > STORAGE_MIN_SOC && currentPrice >= dischargePriceAbove) return 'DISCHARGE';
  return 'HOLD';
}

async function optimizeRegisteredBatteries(stellar: StellarService, mqtt: ReturnType<typeof getMqttClient>) {
  const batteries = listDevices({ type: 'battery', status: 'active', limit: 500 }).filter(
    (device) => device.specs.automationEnabled === true &&
      typeof device.specs.chargePriceBelow === 'number' &&
      typeof device.specs.dischargePriceAbove === 'number',
  );
  if (batteries.length === 0) return;

  const rawPrice = await stellar.query('get_current_rate', []);
  const currentPrice = Number(StellarSdk.scValToNative(rawPrice));
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    logger.warn('Storage dispatch skipped because current price is invalid', { currentPrice });
    return;
  }

  for (const battery of batteries) {
    const latest = listPerformance(battery.id, 90).at(-1);
    if (latest?.stateOfCharge === null || latest?.stateOfCharge === undefined) {
      logger.info({ deviceId: battery.id }, 'Storage dispatch skipped until SoC telemetry is received');
      continue;
    }
    const action = chooseRegisteredStorageAction(
      latest.stateOfCharge,
      currentPrice,
      Number(battery.specs.chargePriceBelow),
      Number(battery.specs.dischargePriceAbove),
    );
    mqtt.publish(
      `solargrid/devices/${battery.id}/command`,
      JSON.stringify({ type: 'STORAGE_DISPATCH', action, stateOfCharge: latest.stateOfCharge, price: currentPrice }),
      { qos: 1 },
    );
    storageMetrics.push({
      at: new Date().toISOString(),
      batteryId: battery.id,
      action,
      soc: latest.stateOfCharge,
      savings: 0,
    });
    if (storageMetrics.length > 288) storageMetrics.shift();
  }
}

/**
 * Optimize battery storage charge/discharge cycles to maximize cost savings
 * while preserving battery health (SoC limits, cycle counting, degradation).
 */
export async function optimizeEnergyStorage(stellar: StellarService) {
  const mqtt = getMqttClient();
  try {
    const raw = await stellar.query('get_all_batteries', []);
    const batteries = (StellarSdk.scValToNative(raw) as any[]) ?? [];
    for (const battery of batteries) {
      const batteryId = battery.id;
      const state = getStorageState(batteryId, battery);
      const priceHistory: number[] = (battery.price_history ?? []).map((p: any) => Number(p));
      const currentPrice = Number(battery.price ?? state.lastPrice);
      state.lastPrice = currentPrice;

      const predicted = predictPrices(priceHistory.length ? priceHistory : [currentPrice]);
      const action = optimizeStorageCycle(state, predicted);

      // Battery health monitoring: apply degradation per cycle and enforce SoC limits.
      const energyKwh = state.capacityKwh * 0.1;
      if (action === 'CHARGE') {
        state.soc = Math.min(STORAGE_MAX_SOC, state.soc + 0.1);
        state.optimizedCost += currentPrice * energyKwh;
        state.baselineCost += currentPrice * energyKwh;
      } else if (action === 'DISCHARGE') {
        state.soc = Math.max(STORAGE_MIN_SOC, state.soc - 0.1);
        state.cycles += 1;
        state.health = Math.max(0, state.health - STORAGE_DEGRADE_PER_CYCLE);
        const displaced = currentPrice * energyKwh;
        state.optimizedCost += displaced / STORAGE_ROUND_TRIP_EFFICIENCY - displaced;
        state.baselineCost += displaced;
        state.savings = state.baselineCost - state.optimizedCost;
      }

      mqtt.publish(
        `batteries/${batteryId}/commands`,
        JSON.stringify({
          type: 'STORAGE_OPTIMIZE',
          action,
          soc: state.soc,
          health: state.health,
          cycles: state.cycles,
          predictedPrices: predicted,
        }),
        { qos: 1 },
      );

      storageMetrics.push({
        at: new Date().toISOString(),
        batteryId,
        action,
        soc: state.soc,
        savings: state.savings,
      });
      if (storageMetrics.length > 288) storageMetrics.shift();

      logger.info('Storage optimization cycle', {
        batteryId,
        action,
        soc: state.soc,
        health: state.health,
        savings: state.savings,
      });
    }
  } catch (err) {
    logger.error('optimizeEnergyStorage error', { err });
  }
  try {
    await optimizeRegisteredBatteries(stellar, mqtt);
  } catch (err) {
    logger.error('Registered battery price dispatch failed', { err });
  }
}

/** Allow a user to override storage automation for a battery. */
export function setStorageAutomation(batteryId: string, enabled: boolean) {
  const state = storageStates.get(batteryId);
  if (state) state.automationEnabled = enabled;
  return state?.automationEnabled ?? enabled;
}

/** Cost savings and performance metrics for storage optimization. */
export function getStorageMetrics() {
  const batteries = Array.from(storageStates.entries()).map(([batteryId, s]) => ({
    batteryId,
    soc: s.soc,
    health: s.health,
    cycles: s.cycles,
    savings: s.savings,
    savingsPct: s.baselineCost > 0 ? (s.savings / s.baselineCost) * 100 : 0,
    automationEnabled: s.automationEnabled,
  }));
  return { batteries, history: storageMetrics.slice() };
}

// Limit watcher initialization guard to prevent duplicate startup
let watcherStarted = false;

function scheduleWarnedReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    warnedToday.clear();
    scheduleWarnedReset();
  }, midnight.getTime() - now.getTime());
}

/**
 * Detect network congestion from aggregate load signals and, when the state
 * changes, apply dynamic pricing, shed non-critical loads, and notify users.
 */
export async function checkNetworkCongestion(stellar: StellarService) {
  try {
    const raw = await stellar.query('get_all_meters', []);
    const meters = (StellarSdk.scValToNative(raw) as any[]) ?? [];
    if (meters.length === 0) return;

    let totalLoad = 0;
    let totalCapacity = 0;
    for (const meter of meters) {
      totalLoad += Number(meter.current_load ?? 0);
      totalCapacity += Number(meter.capacity ?? meter.daily_limit ?? 0);
    }
    if (totalCapacity <= 0) return;

    const load = totalLoad / totalCapacity;
    const wasCongested = congested;
    if (!congested && load >= CONGESTION_THRESHOLD) congested = true;
    else if (congested && load <= CONGESTION_CLEAR_THRESHOLD) congested = false;

    congestionHistory.push({ at: new Date().toISOString(), load, congested });
    if (congestionHistory.length > 288) congestionHistory.shift();

    if (congested === wasCongested) return;

    const mqtt = getMqttClient();
    if (congested) {
      // Dynamic pricing during congestion.
      const priceMultiplier = CONGESTION_PEAK_MULTIPLIER;
      // Load shedding: shed non-critical loads only, keep critical loads online.
      const shedMeters = meters
        .filter((m) => !m.critical && Number(m.current_load ?? 0) > 0)
        .map((m) => ({ meterId: m.id, shedTo: Number(m.current_load) * (1 - CONGESTION_SHED_RATIO) }));

      mqtt.publish(
        'network/congestion',
        JSON.stringify({ type: 'CONGESTION_START', load, priceMultiplier, shedMeters }),
        { qos: 1 },
      );
      for (const shed of shedMeters) {
        mqtt.publish(
          `meters/${shed.meterId}/commands`,
          JSON.stringify({ type: 'SHED_LOAD', targetLoad: shed.shedTo, reason: 'CONGESTION' }),
          { qos: 1 },
        );
      }
      for (const meter of meters) {
        mqtt.publish(
          `meters/${meter.id}/notifications`,
          JSON.stringify({ type: 'CONGESTION_NOTICE', load, priceMultiplier }),
          { qos: 1 },
        );
      }
      logger.info('Network congestion detected', { load, priceMultiplier, shedCount: shedMeters.length });
    } else {
      mqtt.publish(
        'network/congestion',
        JSON.stringify({ type: 'CONGESTION_END', load }),
        { qos: 1 },
      );
      for (const meter of meters) {
        mqtt.publish(
          `meters/${meter.id}/notifications`,
          JSON.stringify({ type: 'CONGESTION_CLEARED', load }),
          { qos: 1 },
        );
      }
      logger.info('Network congestion cleared', { load });
    }
  } catch (err) {
    logger.error('checkNetworkCongestion error', { err });
  }
}

/** Historical congestion analytics. */
export function getCongestionHistory() {
  return congestionHistory.slice();
}

export async function checkDailyLimits(stellar: StellarService) {
  try {
    const raw = await stellar.query('get_all_meters', []);
    const meters = (StellarSdk.scValToNative(raw) as any[]) ?? [];
    for (const meter of meters) {
      if (Number(meter.daily_limit) > 0) {
        const ratio = Number(meter.day_spent) / Number(meter.daily_limit);
        if (ratio >= THRESHOLD && !warnedToday.has(meter.id)) {
          getMqttClient().publish(
            `meters/${meter.id}/warnings`,
            JSON.stringify({ type: 'DAILY_LIMIT_WARNING', ratio, meterId: meter.id }),
            { qos: 1 },
          );
          warnedToday.add(meter.id);
          logger.info('Daily limit warning published', { meterId: meter.id, ratio });
        }
      }
    }
  } catch (err) {
    logger.error('checkDailyLimits error', { err });
  }
}

export function startLimitWatcher(stellar: StellarService) {
  if (watcherStarted) {
    logger.warn("Limit watcher already started, skipping duplicate initialization");
    return;
  }
  watcherStarted = true;
  scheduleWarnedReset();
  const intervalMs = Number(process.env.LIMIT_WATCH_INTERVAL_MS ?? 5 * 60 * 1000);
  setInterval(() => checkDailyLimits(stellar), intervalMs);
  setInterval(() => checkNetworkCongestion(stellar), intervalMs);
  setInterval(() => optimizeEnergyStorage(stellar), intervalMs);
}
