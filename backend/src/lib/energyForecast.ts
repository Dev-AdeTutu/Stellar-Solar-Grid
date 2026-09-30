import { logger } from "./logger.js";
import { getHourlyUsage, getMeterUsageStats } from "./usageEvents.js";
import { listDevices, listPerformance } from "./deviceRegistry.js";
import { predictHourly, trainHourlyModel, type HourlyEnergyModel, type HourlyEnergySample } from "./energyForecastModel.js";

export const FORECAST_TRAINING_WINDOW_DAYS = 90;
export const FORECAST_RETRAIN_INTERVAL_MS = Number(process.env.ENERGY_FORECAST_RETRAIN_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

type CachedModel = { model: HourlyEnergyModel; trainedAtMs: number };
const models = new Map<string, CachedModel>();
let retrainingTimer: NodeJS.Timeout | undefined;

function startOfHour(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function solarSamples(deviceId: string, now: Date): HourlyEnergySample[] {
  const byHour = new Map<string, number>();
  for (const reading of listPerformance(deviceId, FORECAST_TRAINING_WINDOW_DAYS, now)) {
    const hour = startOfHour(reading.recordedAt);
    if (!hour || reading.energyKwh === null || !Number.isFinite(reading.energyKwh) || reading.energyKwh < 0) continue;
    byHour.set(hour, (byHour.get(hour) ?? 0) + reading.energyKwh);
  }
  const first = new Date(now.getTime() - FORECAST_TRAINING_WINDOW_DAYS * 86_400_000);
  first.setUTCMinutes(0, 0, 0);
  const last = new Date(now);
  last.setUTCMinutes(0, 0, 0);
  const samples: HourlyEnergySample[] = [];
  for (let hour = first.getTime(); hour <= last.getTime(); hour += 3_600_000) {
    const timestamp = new Date(hour).toISOString();
    samples.push({ timestamp, energyKwh: byHour.get(timestamp) ?? 0 });
  }
  return samples;
}

function train(key: string, samples: HourlyEnergySample[], now: Date): HourlyEnergyModel {
  const model = trainHourlyModel(samples, now);
  models.set(key, { model, trainedAtMs: now.getTime() });
  return model;
}

function cachedOrTrain(key: string, loadSamples: () => HourlyEnergySample[], now: Date): HourlyEnergyModel {
  const cached = models.get(key);
  if (cached && now.getTime() - cached.trainedAtMs < FORECAST_RETRAIN_INTERVAL_MS) return cached.model;
  return train(key, loadSamples(), now);
}

export function getMeterEnergyModel(meterId: string, now = new Date()): HourlyEnergyModel {
  return cachedOrTrain(
    `meter:${meterId}`,
    () => getHourlyUsage(meterId, FORECAST_TRAINING_WINDOW_DAYS, now),
    now,
  );
}

export function getSolarEnergyModel(deviceId: string, now = new Date()): HourlyEnergyModel {
  return cachedOrTrain(`solar:${deviceId}`, () => solarSamples(deviceId, now), now);
}

export async function retrainAllEnergyForecasts(now = new Date()): Promise<{ meters: number; devices: number }> {
  let meters = 0;
  let devices = 0;
  for (const { meter_id: meterId } of getMeterUsageStats().slice(0, 500)) {
    try {
      train(`meter:${meterId}`, getHourlyUsage(meterId, FORECAST_TRAINING_WINDOW_DAYS, now), now);
      meters++;
    } catch (err) {
      logger.warn({ err, meterId }, "Energy consumption model retraining failed");
    }
  }
  for (const device of listDevices({ type: "solar_panel", status: "active", limit: 500 })) {
    try {
      train(`solar:${device.id}`, solarSamples(device.id, now), now);
      devices++;
    } catch (err) {
      logger.warn({ err, deviceId: device.id }, "Solar production model retraining failed");
    }
  }
  logger.info({ meters, devices }, "Energy forecast models retrained");
  return { meters, devices };
}

export function startEnergyForecastRetraining(intervalMs = FORECAST_RETRAIN_INTERVAL_MS): void {
  if (retrainingTimer) return;
  retrainAllEnergyForecasts().catch((err) => logger.error({ err }, "Initial energy forecast retraining failed"));
  retrainingTimer = setInterval(() => {
    retrainAllEnergyForecasts().catch((err) => logger.error({ err }, "Scheduled energy forecast retraining failed"));
  }, intervalMs);
  retrainingTimer.unref?.();
}

export function stopEnergyForecastRetraining(): void {
  if (retrainingTimer) clearInterval(retrainingTimer);
  retrainingTimer = undefined;
}

export function clearEnergyForecastModelsForTests(): void {
  models.clear();
}

export { predictHourly };