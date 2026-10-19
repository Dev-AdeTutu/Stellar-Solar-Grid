/**
 * Weather endpoints (#900).
 *
 *   GET /api/weather/current?lat=&lon=
 *   GET /api/weather/forecast?lat=&lon=              — 7-day daily forecast
 *   GET /api/weather/production-forecast?lat=&lon=&capacityKw=&peakSunHours=&efficiency=&panelAgeYears=
 *                                                    — weather-adjusted 7-day energy prediction
 *   GET /api/weather/energy-forecast?meterId=&deviceId=&lat=&lon=&hours= — weather-adjusted hourly forecast (48h max)
 *   GET /api/weather/alerts?lat=&lon=                — production-impacting weather alerts
 *   GET /api/weather/correlation?deviceId=&lat=&lon= — cloud cover vs. actual device production
 *   GET /api/weather/usage                           — API call budget / cache stats
 */
import { Router, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  WeatherUnavailableError,
  deriveAlerts,
  forecastProduction,
  getObservations,
  getWeather,
  getWeatherUsage,
  pearson,
  recordObservation,
  weatherProductionFactor,
} from "../lib/weather.js";
import { getDevice, listPerformance } from "../lib/deviceRegistry.js";
import { getMeterEnergyModel, getSolarEnergyModel, predictHourly } from "../lib/energyForecast.js";
import { calcDailyKwh } from "./solar.js";

export const weatherRouter = Router();

function coords(req: Request) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (req.query.lat === undefined || req.query.lon === undefined) {
    throw new WeatherUnavailableError("lat and lon query parameters are required", 400);
  }
  return { lat, lon };
}

function positive(v: unknown, name: string, fallback?: number, max = Infinity): number {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new WeatherUnavailableError(`${name} must be a positive number${max < Infinity ? ` ≤ ${max}` : ""}`, 400);
  }
  return n;
}

/** Wrap a handler so WeatherUnavailableError maps to its HTTP status. */
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof WeatherUnavailableError) {
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    }
  });

async function load(req: Request) {
  const { lat, lon } = coords(req);
  const report = await getWeather(lat, lon);
  recordObservation(report);
  return report;
}

weatherRouter.get(
  "/current",
  handle(async (req, res) => {
    const report = await load(req);
    res.json({ location: report.location, current: report.current, fetchedAt: report.fetchedAt, stale: report.stale });
  }),
);

weatherRouter.get(
  "/forecast",
  handle(async (req, res) => {
    const report = await load(req);
    res.json({
      location: report.location,
      daily: report.daily.slice(0, 7),
      fetchedAt: report.fetchedAt,
      stale: report.stale,
    });
  }),
);

weatherRouter.get(
  "/production-forecast",
  handle(async (req, res) => {
    const capacityKw = positive(req.query.capacityKw, "capacityKw", undefined, 10_000);
    const peakSunHours = positive(req.query.peakSunHours, "peakSunHours", 5, 24);
    const efficiency = positive(req.query.efficiency, "efficiency", 0.2, 1);
    const panelAgeYears = req.query.panelAgeYears === undefined ? 0 : Number(req.query.panelAgeYears);
    if (!Number.isFinite(panelAgeYears) || panelAgeYears < 0) {
      throw new WeatherUnavailableError("panelAgeYears must be a non-negative number", 400);
    }
    const report = await load(req);
    const baseline = calcDailyKwh(capacityKw, peakSunHours, efficiency, panelAgeYears);
    const days = forecastProduction(report.daily, baseline);
    res.json({
      location: report.location,
      clearSkyDailyKwh: Number(baseline.toFixed(3)),
      totalExpectedKwh: Number(days.reduce((s, d) => s + d.expectedKwh, 0).toFixed(3)),
      days,
      fetchedAt: report.fetchedAt,
      stale: report.stale,
    });
  }),
);

function clearSkyHourlyKwh(capacityKw: number, latitude: number, longitude: number, timestamp: string): number {
  const date = new Date(timestamp);
  const yearDay = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86_400_000);
  const declination = 23.45 * Math.sin((2 * Math.PI * (284 + yearDay)) / 365) * Math.PI / 180;
  const latitudeRad = latitude * Math.PI / 180;
  const solarHour = (date.getUTCHours() + date.getUTCMinutes() / 60 + longitude / 15 + 24) % 24;
  const hourAngle = (solarHour - 12) * 15 * Math.PI / 180;
  const sineElevation = Math.sin(latitudeRad) * Math.sin(declination) +
    Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  return capacityKw * 0.86 * Math.max(0, sineElevation);
}

weatherRouter.get(
  "/energy-forecast",
  handle(async (req, res) => {
    const meterId = typeof req.query.meterId === "string" ? req.query.meterId.trim() : "";
    const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
    if (!meterId && !deviceId) throw new WeatherUnavailableError("meterId or deviceId is required", 400);
    if (meterId.length > 64 || deviceId.length > 100) throw new WeatherUnavailableError("meterId or deviceId is too long", 400);

    const device = deviceId ? getDevice(deviceId) : undefined;
    if (deviceId && !device) return res.status(404).json({ error: "Device not found" });
    if (device && device.type !== "solar_panel") {
      throw new WeatherUnavailableError("deviceId must refer to a registered solar_panel", 400);
    }

    const lat = req.query.lat === undefined ? Number(device?.specs.latitude) : Number(req.query.lat);
    const lon = req.query.lon === undefined ? Number(device?.specs.longitude) : Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new WeatherUnavailableError("lat/lon are required (or set latitude/longitude on the solar device)", 400);
    }
    const hours = positive(req.query.hours, "hours", 48, 48);
    if (!Number.isInteger(hours)) throw new WeatherUnavailableError("hours must be an integer", 400);

    const report = await getWeather(lat, lon);
    recordObservation(report);
    if (report.hourly.length < hours) {
      throw new WeatherUnavailableError(`Weather provider returned ${report.hourly.length} hourly points; ${hours} are required`, 502);
    }
    const observations = [...getObservations(lat, lon).values()];
    const observedProductionFactors = observations.map((observation) => weatherProductionFactor(observation));
    const baselineProductionFactor = observedProductionFactors.length
      ? observedProductionFactors.reduce((sum, factor) => sum + factor, 0) / observedProductionFactors.length
      : 1;
    const baselineTemperature = observations.length
      ? observations.reduce((sum, observation) => sum + observation.temperatureC, 0) / observations.length
      : 20;

    const productionModel = device ? getSolarEnergyModel(device.id) : null;
    const consumptionModel = meterId ? getMeterEnergyModel(meterId) : null;
    const capacityKw = device ? Number(device.specs.ratedPowerW) / 1000 : null;
    if (device && (!Number.isFinite(capacityKw) || capacityKw! <= 0) && productionModel!.observedSamples === 0) {
      throw new WeatherUnavailableError("Solar device needs ratedPowerW or historical production telemetry", 400);
    }

    const forecasts = report.hourly.slice(0, hours).map((weather) => {
      const productionWeatherFactor = weatherProductionFactor(weather);
      const consumptionWeatherFactor = Math.max(0.7, Math.min(1.3, 1 + (weather.temperatureC - baselineTemperature) * 0.01));
      let productionKwh: number | null = null;
      if (device && productionModel) {
        const historicalPattern = productionModel.observedSamples > 0
          ? predictHourly(productionModel, weather.time)
          : clearSkyHourlyKwh(capacityKw!, lat, lon, weather.time);
        const factorRatio = productionModel.observedSamples > 0
          ? productionWeatherFactor / Math.max(0.15, baselineProductionFactor)
          : productionWeatherFactor;
        productionKwh = historicalPattern * factorRatio;
      }
      const consumptionKwh = consumptionModel && consumptionModel.observedSamples > 0
        ? predictHourly(consumptionModel, weather.time) * consumptionWeatherFactor
        : null;
      return {
        timestamp: weather.time,
        productionKwh: productionKwh === null ? null : Number(productionKwh.toFixed(4)),
        consumptionKwh: consumptionKwh === null ? null : Number(consumptionKwh.toFixed(4)),
        weather: {
          temperatureC: weather.temperatureC,
          cloudCoverPct: weather.cloudCoverPct,
          precipitationProbability: weather.precipitationProbability,
          condition: weather.condition,
          productionFactor: Number(productionWeatherFactor.toFixed(3)),
          consumptionTemperatureFactor: Number(consumptionWeatherFactor.toFixed(3)),
        },
      };
    });

    res.json({
      meterId: meterId || null,
      deviceId: deviceId || null,
      horizonHours: hours,
      generatedAt: new Date().toISOString(),
      location: report.location,
      weatherStale: report.stale,
      models: {
        production: productionModel ? {
          algorithm: "seasonal-ridge",
          trainingSamples: productionModel.trainingSamples,
          accuracyPct: productionModel.accuracyPct,
          trainedAt: productionModel.trainedAt,
        } : null,
        consumption: consumptionModel ? {
          algorithm: "seasonal-ridge",
          trainingSamples: consumptionModel.trainingSamples,
          accuracyPct: consumptionModel.accuracyPct,
          trainedAt: consumptionModel.trainedAt,
        } : null,
      },
      forecast: forecasts,
    });
  }),
);

weatherRouter.get(
  "/alerts",
  handle(async (req, res) => {
    const report = await load(req);
    res.json({ location: report.location, alerts: deriveAlerts(report), fetchedAt: report.fetchedAt });
  }),
);

weatherRouter.get(
  "/correlation",
  handle(async (req, res) => {
    const deviceId = String(req.query.deviceId ?? "");
    const device = getDevice(deviceId);
    if (!device) return res.status(404).json({ error: "Device not found" });
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : Number(device.specs.latitude);
    const lon = req.query.lon !== undefined ? Number(req.query.lon) : Number(device.specs.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new WeatherUnavailableError("lat/lon required (or set specs.latitude/longitude on the device)", 400);
    }

    const energyByDay = new Map<string, number>();
    for (const r of listPerformance(deviceId, 90)) {
      const day = r.recordedAt.slice(0, 10);
      energyByDay.set(day, (energyByDay.get(day) ?? 0) + (r.energyKwh ?? 0));
    }
    const points: Array<{ date: string; cloudCoverPct: number; temperatureC: number; energyKwh: number }> = [];
    for (const [date, obs] of getObservations(lat, lon)) {
      const energy = energyByDay.get(date);
      if (energy !== undefined) points.push({ date, ...obs, energyKwh: Number(energy.toFixed(3)) });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    res.json({
      deviceId,
      days: points.length,
      cloudCoverCorrelation: pearson(points.map((p) => p.cloudCoverPct), points.map((p) => p.energyKwh)),
      temperatureCorrelation: pearson(points.map((p) => p.temperatureC), points.map((p) => p.energyKwh)),
      points,
    });
  }),
);

weatherRouter.get("/usage", (_req, res) => {
  res.json(getWeatherUsage());
});
