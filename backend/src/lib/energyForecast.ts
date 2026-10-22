import { logger } from "./logger.js";
import { getHourlyUsage, getMeterUsageStats } from "./usageEvents.js";
import { listDevices, listPerformance } from "./deviceRegistry.js";
import { predictHourly, trainHourlyModel, type HourlyEnergyModel, type HourlyEnergySample } from "./energyForecastModel.js";
import { getWeatherReport, type WeatherReport } from "./weather.js";
import { getMeter } from "./meters.js";

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
  weatherForecastCache.clear();
}

export type WeatherUsageForecastDay = {
  date: string;
  predictedUsageKwh: number;
  lowerKwh: number;
  upperKwh: number;
  avgTemperatureC: number;
  sunlightHours: number;
};

export type WeatherUsageForecast = {
  meterId: string;
  generatedAt: string;
  days: WeatherUsageForecastDay[];
  predictedDaysUntilEmpty: number | null;
  willRunOutOfCredit: boolean;
  alertDate: string | null;
};

export type WeatherSolarForecastDay = {
  date: string;
  predictedGenerationKwh: number;
  lowerKwh: number;
  upperKwh: number;
  sunlightHours: number;
};

export type WeatherSolarForecast = {
  deviceId: string;
  generatedAt: string;
  days: WeatherSolarForecastDay[];
};

const weatherForecastCache = new Map<string, { day: string; value: unknown }>();

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function cacheGet<T>(key: string, now: Date): T | undefined {
  const entry = weatherForecastCache.get(key);
  if (entry && entry.day === dayKey(now)) return entry.value as T;
  return undefined;
}

function cacheSet(key: string, now: Date, value: unknown): void {
  weatherForecastCache.set(key, { day: dayKey(now), value });
}

function dailyWeather(report: WeatherReport, now: Date, days: number): Array<{ date: string; avgTemperatureC: number; sunlightHours: number }> {
  const buckets = new Map<string, { temps: number[]; sunlight: number }>();
  for (const point of report.hourly) {
    const date = point.timestamp.slice(0, 10);
    const bucket = buckets.get(date) ?? { temps: [], sunlight: 0 };
    if (Number.isFinite(point.temperatureC)) bucket.temps.push(point.temperatureC);
    if (Number.isFinite(point.cloudCoverPercent)) {
      const clear = Math.max(0, 1 - point.cloudCoverPercent / 100);
      bucket.sunlight += clear;
    }
    buckets.set(date, bucket);
  }
  const out: Array<{ date: string; avgTemperatureC: number; sunlightHours: number }> = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const bucket = buckets.get(date);
    const temps = bucket?.temps ?? [];
    const avgTemperatureC = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : report.current.temperatureC;
    out.push({ date, avgTemperatureC, sunlightHours: bucket?.sunlight ?? 0 });
  }
  return out;
}

function temperatureFactor(avgTemperatureC: number): number {
  const deviation = Math.abs(avgTemperatureC - 18);
  return 1 + Math.min(0.6, deviation * 0.02);
}

export async function getWeatherUsageForecast(
  meterId: string,
  lat: number,
  lon: number,
  now = new Date(),
): Promise<WeatherUsageForecast> {
  const cacheKey = `usage:${meterId}`;
  const cached = cacheGet<WeatherUsageForecast>(cacheKey, now);
  if (cached) return cached;

  const report = await getWeatherReport(lat, lon, now);
  const model = getMeterEnergyModel(meterId, now);
  const days = dailyWeather(report, now, 7);

  const forecastDays: WeatherUsageForecastDay[] = days.map((day) => {
    const base = predictHourly(model, new Date(`${day.date}T12:00:00.000Z`));
    const predicted = base * temperatureFactor(day.avgTemperatureC);
    const band = Math.max(0.1, predicted * 0.15);
    return {
      date: day.date,
      predictedUsageKwh: Number(predicted.toFixed(3)),
      lowerKwh: Number(Math.max(0, predicted - band).toFixed(3)),
      upperKwh: Number((predicted + band).toFixed(3)),
      avgTemperatureC: Number(day.avgTemperatureC.toFixed(1)),
      sunlightHours: Number(day.sunlightHours.toFixed(1)),
    };
  });

  const totalPredicted = forecastDays.reduce((sum, day) => sum + day.predictedUsageKwh, 0);
  const dailyAverage = forecastDays.length ? totalPredicted / forecastDays.length : 0;
  const meter = getMeter(meterId);
  const balance = meter?.credit_balance ?? null;
  let predictedDaysUntilEmpty: number | null = null;
  let willRunOutOfCredit = false;
  let alertDate: string | null = null;
  if (balance !== null && dailyAverage > 0) {
    predictedDaysUntilEmpty = Number((balance / dailyAverage).toFixed(1));
    willRunOutOfCredit = predictedDaysUntilEmpty <= 7;
    if (willRunOutOfCredit) {
      alertDate = new Date(now.getTime() + predictedDaysUntilEmpty * 86_400_000).toISOString().slice(0, 10);
    }
  }

  const result: WeatherUsageForecast = {
    meterId,
    generatedAt: now.toISOString(),
    days: forecastDays,
    predictedDaysUntilEmpty,
    willRunOutOfCredit,
    alertDate,
  };
  cacheSet(cacheKey, now, result);
  return result;
}

export async function getWeatherSolarForecast(
  deviceId: string,
  lat: number,
  lon: number,
  now = new Date(),
): Promise<WeatherSolarForecast> {
  const cacheKey = `solar:${deviceId}`;
  const cached = cacheGet<WeatherSolarForecast>(cacheKey, now);
  if (cached) return cached;

  const report = await getWeatherReport(lat, lon, now);
  const model = getSolarEnergyModel(deviceId, now);
  const days = dailyWeather(report, now, 7);

  const forecastDays: WeatherSolarForecastDay[] = days.map((day) => {
    const base = predictHourly(model, new Date(`${day.date}T12:00:00.000Z`));
    const sunlightFactor = Math.max(0, Math.min(1.5, day.sunlightHours / 12));
    const predicted = base * sunlightFactor;
    const band = Math.max(0.05, predicted * 0.2);
    return {
      date: day.date,
      predictedGenerationKwh: Number(predicted.toFixed(3)),
      lowerKwh: Number(Math.max(0, predicted - band).toFixed(3)),
      upperKwh: Number((predicted + band).toFixed(3)),
      sunlightHours: Number(day.sunlightHours.toFixed(1)),
    };
  });

  const result: WeatherSolarForecast = {
    deviceId,
    generatedAt: now.toISOString(),
    days: forecastDays,
  };
  cacheSet(cacheKey, now, result);
  return result;
}

export { predictHourly };