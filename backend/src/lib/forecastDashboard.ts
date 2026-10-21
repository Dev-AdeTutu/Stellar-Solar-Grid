/**
 * 7-day energy forecasting dashboard model (#1082). See frontend/FORECASTING.md.
 *
 * Baseline = mean of the last 28 daily actuals (falls back to defaults when no
 * history). Generation is scaled by the weather production factor of each
 * forecast day; consumption is scaled by heating/cooling degree days. The 95%
 * confidence interval widens with horizon: ±1.96·σ·√(1 + h/7).
 * Issued forecasts are snapshotted so they can be compared with actuals later.
 */
import { weatherProductionFactor, type DailyForecast } from "./weather.js";

export const FORECAST_DAYS = 7;
const HISTORY_DAYS = 28;
const DEFAULT_GENERATION_KWH = Number(process.env.FORECAST_DEFAULT_GENERATION_KWH ?? 12);
const DEFAULT_CONSUMPTION_KWH = Number(process.env.FORECAST_DEFAULT_CONSUMPTION_KWH ?? 10);
const COMFORT_TEMP_C = 21;
/** Fractional consumption change per degree away from comfort temperature. */
const DEGREE_DAY_SENSITIVITY = 0.03;

export interface DailyActual {
  date: string;
  generationKwh: number;
  consumptionKwh: number;
}

export interface Band {
  value: number;
  lower: number;
  upper: number;
}

export interface ForecastDay {
  date: string;
  generation: Band;
  consumption: Band;
  netKwh: number;
  weatherAdjusted: boolean;
  weather?: { cloudCoverPct: number; tempMaxC: number; condition: string };
}

const actuals = new Map<string, Map<string, DailyActual>>();
/** meterId -> date -> forecast issued for that date (latest issue wins). */
const issued = new Map<string, Map<string, ForecastDay>>();

export function recordActual(meterId: string, actual: DailyActual): DailyActual {
  const m = actuals.get(meterId) ?? new Map();
  m.set(actual.date, actual);
  actuals.set(meterId, m);
  return actual;
}

function stats(values: number[], fallback: number) {
  if (values.length === 0) return { mean: fallback, std: fallback * 0.25 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) : (mean * 0.25) ** 2;
  return { mean, std: Math.sqrt(variance) };
}

function band(value: number, std: number, horizon: number): Band {
  const margin = 1.96 * std * Math.sqrt(1 + horizon / FORECAST_DAYS);
  return { value: r(value), lower: r(Math.max(0, value - margin)), upper: r(value + margin) };
}

function addDays(date: Date, n: number): string {
  return new Date(date.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

export function buildForecast(meterId: string, weather: DailyForecast[] = [], now = new Date()): ForecastDay[] {
  const today = now.toISOString().slice(0, 10);
  const history = [...(actuals.get(meterId)?.values() ?? [])]
    .filter((a) => a.date < today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_DAYS);
  const gen = stats(history.map((a) => a.generationKwh), DEFAULT_GENERATION_KWH);
  const con = stats(history.map((a) => a.consumptionKwh), DEFAULT_CONSUMPTION_KWH);
  const byDate = new Map(weather.map((w) => [w.date, w]));
  // Historical actuals already include an "average" weather mix; normalise by a typical factor.
  const typicalFactor = weatherProductionFactor({ cloudCoverPct: 40, temperatureC: 20 });

  const days: ForecastDay[] = [];
  for (let h = 1; h <= FORECAST_DAYS; h++) {
    const date = addDays(now, h);
    const w = byDate.get(date);
    let g = gen.mean;
    let c = con.mean;
    if (w) {
      g *= weatherProductionFactor({ cloudCoverPct: w.cloudCoverPct, temperatureC: w.tempMaxC, conditionId: w.conditionId }) / typicalFactor;
      const avgTemp = (w.tempMinC + w.tempMaxC) / 2;
      c *= 1 + Math.abs(avgTemp - COMFORT_TEMP_C) * DEGREE_DAY_SENSITIVITY;
    }
    const day: ForecastDay = {
      date,
      generation: band(g, gen.std, h),
      consumption: band(c, con.std, h),
      netKwh: r(g - c),
      weatherAdjusted: !!w,
      ...(w ? { weather: { cloudCoverPct: w.cloudCoverPct, tempMaxC: w.tempMaxC, condition: w.condition } } : {}),
    };
    days.push(day);
  }
  const snap = issued.get(meterId) ?? new Map();
  for (const d of days) snap.set(d.date, d);
  issued.set(meterId, snap);
  return days;
}

/** Forecast vs actual for days that have both, plus MAPE accuracy metrics. */
export function compareForecastToActual(meterId: string) {
  const snap = issued.get(meterId) ?? new Map<string, ForecastDay>();
  const acts = actuals.get(meterId) ?? new Map<string, DailyActual>();
  const rows = [...snap.values()]
    .filter((f) => acts.has(f.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((f) => {
      const a = acts.get(f.date)!;
      return {
        date: f.date,
        forecastGenerationKwh: f.generation.value,
        actualGenerationKwh: a.generationKwh,
        forecastConsumptionKwh: f.consumption.value,
        actualConsumptionKwh: a.consumptionKwh,
        generationWithinInterval: a.generationKwh >= f.generation.lower && a.generationKwh <= f.generation.upper,
        consumptionWithinInterval: a.consumptionKwh >= f.consumption.lower && a.consumptionKwh <= f.consumption.upper,
      };
    });
  const mape = (pairs: [number, number][]) => {
    const valid = pairs.filter(([, actual]) => actual > 0);
    return valid.length ? r((valid.reduce((s, [f, a]) => s + Math.abs(f - a) / a, 0) / valid.length) * 100) : null;
  };
  return {
    rows,
    accuracy: {
      generationMapePct: mape(rows.map((x) => [x.forecastGenerationKwh, x.actualGenerationKwh])),
      consumptionMapePct: mape(rows.map((x) => [x.forecastConsumptionKwh, x.actualConsumptionKwh])),
      intervalCoveragePct: rows.length
        ? r((rows.filter((x) => x.generationWithinInterval && x.consumptionWithinInterval).length / rows.length) * 100)
        : null,
    },
  };
}

export function _resetForecastDashboard(): void {
  actuals.clear();
  issued.clear();
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}
