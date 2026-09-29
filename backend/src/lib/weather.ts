/**
 * Weather data integration (#900).
 *
 * Uses the OpenWeatherMap One Call 3.0 API, which returns current conditions,
 * an 8-day daily forecast and government alerts in a *single* request. Cost
 * controls:
 *
 *  - Coordinates are rounded to WEATHER_COORD_PRECISION decimals (default 2,
 *    ~1 km) so nearby sites share one cache entry.
 *  - Responses are cached for WEATHER_CACHE_TTL_MS (default 30 min).
 *  - Concurrent requests for the same location share one in-flight fetch.
 *  - A daily call budget (WEATHER_DAILY_CALL_BUDGET, default 900 — under the
 *    1,000/day free tier) is enforced; once exhausted, stale cache is served.
 *  - On upstream failure a stale entry (up to 24h old) is served instead.
 *
 * Weather feeds into energy predictions via `weatherProductionFactor`: cloud
 * cover attenuates irradiance (Kasten–Czeplak) and high cell temperature
 * derates panel output.
 */
import { logger } from "./logger.js";

const API_KEY = process.env.OPENWEATHERMAP_API_KEY;
const BASE_URL = process.env.OPENWEATHERMAP_BASE_URL ?? "https://api.openweathermap.org/data/3.0/onecall";
const CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_MS ?? 30 * 60 * 1000);
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const COORD_PRECISION = Number(process.env.WEATHER_COORD_PRECISION ?? 2);
const DAILY_CALL_BUDGET = Number(process.env.WEATHER_DAILY_CALL_BUDGET ?? 900);
const FETCH_TIMEOUT_MS = 5_000;

export type WeatherConditions = {
  time: string;
  temperatureC: number;
  cloudCoverPct: number;
  humidityPct: number;
  windSpeedMs: number;
  uvIndex: number | null;
  conditionId: number;
  condition: string;
  description: string;
  sunrise: string | null;
  sunset: string | null;
};

export type DailyForecast = {
  date: string;
  tempMinC: number;
  tempMaxC: number;
  cloudCoverPct: number;
  precipitationProbability: number;
  rainMm: number;
  windSpeedMs: number;
  uvIndex: number | null;
  conditionId: number;
  condition: string;
  description: string;
  daylightHours: number | null;
};

export type HourlyForecast = {
  time: string;
  temperatureC: number;
  cloudCoverPct: number;
  humidityPct: number;
  windSpeedMs: number;
  precipitationProbability: number;
  rainMm: number;
  uvIndex: number | null;
  conditionId: number;
  condition: string;
};

export type ProviderAlert = {
  sender: string;
  event: string;
  start: string;
  end: string;
  description: string;
};

export type WeatherReport = {
  location: { lat: number; lon: number; timezone: string | null };
  current: WeatherConditions;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
  providerAlerts: ProviderAlert[];
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
};

export class WeatherUnavailableError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message);
  }
}

// ── Cache / budget ──────────────────────────────────────────────────────────

type CacheEntry = { report: Omit<WeatherReport, "cached" | "stale">; fetchedAtMs: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();
let budgetDay = "";
let callsToday = 0;

const round = (v: number) => Number(v.toFixed(COORD_PRECISION));
export const locationKey = (lat: number, lon: number) => `${round(lat)},${round(lon)}`;

function consumeBudget(now: Date): boolean {
  const day = now.toISOString().slice(0, 10);
  if (day !== budgetDay) {
    budgetDay = day;
    callsToday = 0;
  }
  if (callsToday >= DAILY_CALL_BUDGET) return false;
  callsToday += 1;
  return true;
}

export function getWeatherUsage() {
  return {
    configured: Boolean(API_KEY),
    day: budgetDay || new Date().toISOString().slice(0, 10),
    callsToday,
    dailyBudget: DAILY_CALL_BUDGET,
    cachedLocations: cache.size,
    cacheTtlMs: CACHE_TTL_MS,
  };
}

// ── OpenWeatherMap mapping ──────────────────────────────────────────────────

const iso = (unix?: number) => (typeof unix === "number" ? new Date(unix * 1000).toISOString() : null);

function mapCurrent(c: any): WeatherConditions {
  const w = c.weather?.[0] ?? {};
  return {
    time: iso(c.dt)!,
    temperatureC: c.temp,
    cloudCoverPct: c.clouds ?? 0,
    humidityPct: c.humidity ?? 0,
    windSpeedMs: c.wind_speed ?? 0,
    uvIndex: c.uvi ?? null,
    conditionId: w.id ?? 800,
    condition: w.main ?? "Clear",
    description: w.description ?? "",
    sunrise: iso(c.sunrise),
    sunset: iso(c.sunset),
  };
}

function mapDaily(d: any): DailyForecast {
  const w = d.weather?.[0] ?? {};
  return {
    date: new Date(d.dt * 1000).toISOString().slice(0, 10),
    tempMinC: d.temp?.min,
    tempMaxC: d.temp?.max,
    cloudCoverPct: d.clouds ?? 0,
    precipitationProbability: d.pop ?? 0,
    rainMm: d.rain ?? 0,
    windSpeedMs: d.wind_speed ?? 0,
    uvIndex: d.uvi ?? null,
    conditionId: w.id ?? 800,
    condition: w.main ?? "Clear",
    description: w.description ?? "",
    daylightHours:
      typeof d.sunrise === "number" && typeof d.sunset === "number"
        ? Number(((d.sunset - d.sunrise) / 3600).toFixed(2))
        : null,
  };
}

function mapHourly(h: any): HourlyForecast {
  const w = h.weather?.[0] ?? {};
  return {
    time: iso(h.dt)!,
    temperatureC: h.temp,
    cloudCoverPct: h.clouds ?? 0,
    humidityPct: h.humidity ?? 0,
    windSpeedMs: h.wind_speed ?? 0,
    precipitationProbability: h.pop ?? 0,
    rainMm: h.rain?.["1h"] ?? 0,
    uvIndex: h.uvi ?? null,
    conditionId: w.id ?? 800,
    condition: w.main ?? "Clear",
  };
}

async function fetchFromProvider(lat: number, lon: number): Promise<CacheEntry> {
  const url = new URL(BASE_URL);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("exclude", "minutely");
  url.searchParams.set("units", "metric");
  url.searchParams.set("appid", API_KEY!);

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new WeatherUnavailableError(`OpenWeatherMap responded ${res.status}`, 502);
  const body: any = await res.json();
  const fetchedAtMs = Date.now();
  return {
    fetchedAtMs,
    report: {
      location: { lat, lon, timezone: body.timezone ?? null },
      current: mapCurrent(body.current ?? {}),
      hourly: (body.hourly ?? []).slice(0, 48).map(mapHourly),
      daily: (body.daily ?? []).slice(0, 8).map(mapDaily),
      providerAlerts: (body.alerts ?? []).map((a: any) => ({
        sender: a.sender_name ?? "",
        event: a.event ?? "",
        start: iso(a.start)!,
        end: iso(a.end)!,
        description: a.description ?? "",
      })),
      fetchedAt: new Date(fetchedAtMs).toISOString(),
    },
  };
}

/** Current conditions + 8-day forecast for a location, served from cache when fresh. */
export async function getWeather(lat: number, lon: number, now = new Date()): Promise<WeatherReport> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new WeatherUnavailableError("lat must be in [-90, 90] and lon in [-180, 180]", 400);
  }
  const key = locationKey(lat, lon);
  const hit = cache.get(key);
  const age = hit ? now.getTime() - hit.fetchedAtMs : Infinity;
  if (hit && age < CACHE_TTL_MS) return { ...hit.report, cached: true, stale: false };

  const serveStale = (reason: string) => {
    if (hit && age < STALE_MAX_MS) {
      logger.warn({ key, reason }, "Serving stale weather data");
      return { ...hit.report, cached: true, stale: true };
    }
    return null;
  };

  if (!API_KEY) {
    throw new WeatherUnavailableError("Weather integration not configured (OPENWEATHERMAP_API_KEY)");
  }

  let pending = inFlight.get(key);
  if (!pending) {
    if (!consumeBudget(now)) {
      const stale = serveStale("daily call budget exhausted");
      if (stale) return stale;
      throw new WeatherUnavailableError("Daily weather API budget exhausted", 429);
    }
    const [rLat, rLon] = key.split(",").map(Number);
    pending = fetchFromProvider(rLat, rLon).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  try {
    const entry = await pending;
    cache.set(key, entry);
    return { ...entry.report, cached: false, stale: false };
  } catch (err) {
    logger.warn({ err, key }, "Weather fetch failed");
    const stale = serveStale("upstream failure");
    if (stale) return stale;
    throw err instanceof WeatherUnavailableError
      ? err
      : new WeatherUnavailableError("Weather provider unavailable", 502);
  }
}

// ── Production correlation ──────────────────────────────────────────────────

/** Temperature coefficient of crystalline-silicon panels (fraction per °C above 25 °C cell temp). */
const TEMP_COEFFICIENT = 0.004;
/** Approximate rise of cell temperature above ambient under sun. */
const CELL_TEMP_RISE_C = 20;

/**
 * Fraction (0–1) of clear-sky production expected given the weather.
 *  - Cloud cover: Kasten–Czeplak, G/G_clear = 1 − 0.75·(cloud fraction)^3.4
 *  - Heat: −0.4 %/°C of cell temperature above 25 °C
 *  - Snow (OWM 6xx) covers panels: capped at 20 %
 */
export function weatherProductionFactor(input: {
  cloudCoverPct: number;
  temperatureC: number;
  conditionId?: number;
}): number {
  const cloud = Math.min(1, Math.max(0, input.cloudCoverPct / 100));
  const irradiance = 1 - 0.75 * Math.pow(cloud, 3.4);
  const cellTemp = input.temperatureC + CELL_TEMP_RISE_C;
  const thermal = 1 - Math.max(0, cellTemp - 25) * TEMP_COEFFICIENT;
  let factor = irradiance * thermal;
  const group = Math.floor((input.conditionId ?? 800) / 100);
  if (group === 6) factor = Math.min(factor, 0.2);
  return Math.max(0, Math.min(1, factor));
}

export type DailyProductionForecast = {
  date: string;
  baselineKwh: number;
  weatherFactor: number;
  expectedKwh: number;
  cloudCoverPct: number;
  tempMaxC: number;
  condition: string;
};

/** Apply the weather factor to a clear-sky daily baseline for each forecast day (7 days). */
export function forecastProduction(daily: DailyForecast[], baselineDailyKwh: number): DailyProductionForecast[] {
  return daily.slice(0, 7).map((d) => {
    // Use the daytime-weighted temperature: panels mostly produce near the daily max.
    const factor = weatherProductionFactor({
      cloudCoverPct: d.cloudCoverPct,
      temperatureC: d.tempMaxC,
      conditionId: d.conditionId,
    });
    return {
      date: d.date,
      baselineKwh: Number(baselineDailyKwh.toFixed(3)),
      weatherFactor: Number(factor.toFixed(3)),
      expectedKwh: Number((baselineDailyKwh * factor).toFixed(3)),
      cloudCoverPct: d.cloudCoverPct,
      tempMaxC: d.tempMaxC,
      condition: d.condition,
    };
  });
}

/** Pearson correlation coefficient; null when fewer than 3 points or zero variance. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// Observed daily conditions per location, recorded whenever we fetch, so actual
// production can later be correlated with weather without extra API calls.
const observations = new Map<string, Map<string, { cloudCoverPct: number; temperatureC: number }>>();
const MAX_OBSERVATION_DAYS = 90;

export function recordObservation(report: WeatherReport): void {
  const key = locationKey(report.location.lat, report.location.lon);
  let byDay = observations.get(key);
  if (!byDay) observations.set(key, (byDay = new Map()));
  byDay.set(report.current.time.slice(0, 10), {
    cloudCoverPct: report.current.cloudCoverPct,
    temperatureC: report.current.temperatureC,
  });
  if (byDay.size > MAX_OBSERVATION_DAYS) byDay.delete(byDay.keys().next().value!);
}

export function getObservations(lat: number, lon: number) {
  return observations.get(locationKey(lat, lon)) ?? new Map();
}

// ── Weather-based alerts ────────────────────────────────────────────────────

export type WeatherAlertSeverity = "info" | "warning" | "critical";

export type WeatherAlert = {
  date: string;
  type: "low_production" | "storm" | "snow" | "extreme_heat" | "high_wind" | "provider";
  severity: WeatherAlertSeverity;
  message: string;
  expectedProductionFactor: number | null;
};

const HIGH_WIND_MS = Number(process.env.WEATHER_ALERT_WIND_MS ?? 17);
const EXTREME_HEAT_C = Number(process.env.WEATHER_ALERT_HEAT_C ?? 38);

/** Derive production-impacting alerts from a weather report. */
export function deriveAlerts(report: WeatherReport): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];
  for (const d of report.daily.slice(0, 7)) {
    const factor = weatherProductionFactor({
      cloudCoverPct: d.cloudCoverPct,
      temperatureC: d.tempMaxC,
      conditionId: d.conditionId,
    });
    const group = Math.floor(d.conditionId / 100);
    if (factor < 0.5) {
      alerts.push({
        date: d.date,
        type: "low_production",
        severity: factor < 0.3 ? "critical" : "warning",
        message: `Expected solar production ${Math.round(factor * 100)}% of clear-sky (${d.description || d.condition})`,
        expectedProductionFactor: Number(factor.toFixed(3)),
      });
    }
    if (group === 2) {
      alerts.push({
        date: d.date,
        type: "storm",
        severity: "warning",
        message: "Thunderstorms forecast — risk of surges and outages; check inverter protection",
        expectedProductionFactor: Number(factor.toFixed(3)),
      });
    }
    if (group === 6) {
      alerts.push({
        date: d.date,
        type: "snow",
        severity: "warning",
        message: "Snow forecast — panels may be covered; plan clearing",
        expectedProductionFactor: Number(factor.toFixed(3)),
      });
    }
    if (d.tempMaxC >= EXTREME_HEAT_C) {
      alerts.push({
        date: d.date,
        type: "extreme_heat",
        severity: "info",
        message: `High of ${Math.round(d.tempMaxC)}°C — thermal derating reduces panel output`,
        expectedProductionFactor: Number(factor.toFixed(3)),
      });
    }
    if (d.windSpeedMs >= HIGH_WIND_MS) {
      alerts.push({
        date: d.date,
        type: "high_wind",
        severity: "critical",
        message: `Wind up to ${Math.round(d.windSpeedMs)} m/s — inspect panel mounts`,
        expectedProductionFactor: Number(factor.toFixed(3)),
      });
    }
  }
  for (const a of report.providerAlerts) {
    alerts.push({
      date: a.start.slice(0, 10),
      type: "provider",
      severity: "warning",
      message: `${a.event} (${a.sender})`,
      expectedProductionFactor: null,
    });
  }
  return alerts;
}

export function _resetWeatherCache(): void {
  cache.clear();
  inFlight.clear();
  observations.clear();
  callsToday = 0;
  budgetDay = "";
}
