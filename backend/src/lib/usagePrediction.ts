/**
 * Usage prediction model (#835).
 *
 * Fits a simple least-squares linear regression of daily consumption against
 * day index over the last 30 days, projects future daily usage, and estimates
 * how many days until the balance reaches zero. A confidence interval is
 * derived from the residual standard error of the daily usage (±1.96σ).
 */
import { db as usageDb } from "./usageEvents.js";

export const TRAINING_WINDOW_DAYS = 30;

export type LinearModel = { slope: number; intercept: number; stdError: number; n: number };

export type Prediction = {
  meterId: string;
  balance: number;
  estimatedDaysRemaining: number | null;
  confidenceInterval: { low: number | null; high: number | null; level: number };
  avgDailyUsage: number;
  trendPerDay: number;
  trainingDays: number;
  generatedAt: string;
};

export function fitLinearRegression(ys: number[]): LinearModel {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0, stdError: 0, n };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  ys.forEach((y, x) => {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
  });
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const sse = ys.reduce((acc, y, x) => acc + (y - (intercept + slope * x)) ** 2, 0);
  const stdError = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return { slope, intercept, stdError, n };
}

/** Days until cumulative projected usage exceeds balance, for a given daily offset. */
function daysUntilEmpty(model: LinearModel, balance: number, offset: number, maxDays = 3650) {
  if (balance <= 0) return 0;
  let remaining = balance;
  for (let d = 0; d < maxDays; d++) {
    const usage = Math.max(0, model.intercept + model.slope * (model.n + d) + offset);
    if (usage <= 0 && model.slope <= 0) return null; // never depletes
    if (usage >= remaining) return d + remaining / usage;
    remaining -= usage;
  }
  return null;
}

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export function predictDaysRemaining(
  meterId: string,
  balance: number,
  dailyUsage: number[],
  now = new Date(),
): Prediction {
  const model = fitLinearRegression(dailyUsage);
  const margin = 1.96 * model.stdError;
  const avg = dailyUsage.length ? dailyUsage.reduce((a, b) => a + b, 0) / dailyUsage.length : 0;
  return {
    meterId,
    balance,
    estimatedDaysRemaining: model.n ? round(daysUntilEmpty(model, balance, 0)) : null,
    confidenceInterval: {
      // Higher usage → fewer days (low bound); lower usage → more days (high bound).
      low: model.n ? round(daysUntilEmpty(model, balance, margin)) : null,
      high: model.n ? round(daysUntilEmpty(model, balance, -margin)) : null,
      level: 0.95,
    },
    avgDailyUsage: avg,
    trendPerDay: model.slope,
    trainingDays: model.n,
    generatedAt: now.toISOString(),
  };
}

/** Daily usage cost in stroops (comparable to on-chain balance) for the last `days` days, oldest first, zero-filled. */
export function getDailyUsage(meterId: string, days = TRAINING_WINDOW_DAYS, now = new Date()) {
  const rows = usageDb()
    .prepare(
      `SELECT date(received_at) AS day, SUM(CAST(cost AS INTEGER)) AS units
         FROM usage_events
        WHERE meter_id = ? AND received_at >= datetime(?, ?)
        GROUP BY day`,
    )
    .all(meterId, now.toISOString(), `-${days} days`) as Array<{ day: string; units: number }>;
  if (rows.length === 0) return [];
  const byDay = new Map(rows.map((r) => [r.day, Number(r.units)]));
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(d) ?? 0);
  }
  return out;
}

// ── Daily cache: predictions are recomputed at most once per day ────────────
const cache = new Map<string, { day: string; balance: number; prediction: Prediction }>();

export function getPrediction(meterId: string, balance: number, now = new Date()): Prediction {
  const day = now.toISOString().slice(0, 10);
  const hit = cache.get(meterId);
  if (hit && hit.day === day && hit.balance === balance) return hit.prediction;
  const prediction = predictDaysRemaining(meterId, balance, getDailyUsage(meterId, TRAINING_WINDOW_DAYS, now), now);
  cache.set(meterId, { day, balance, prediction });
  return prediction;
}

export function _clearPredictionCache() {
  cache.clear();
}
