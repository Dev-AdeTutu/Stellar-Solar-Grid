/**
 * Energy trading strategy backtesting (#940).
 *
 * Historical data: a daily XLM-per-kWh price series. Real prices can be loaded
 * from BACKTEST_PRICES_PATH (JSON array of { date, price }); otherwise a
 * deterministic series is generated (seasonality + weekly cycle + seeded noise)
 * so every backtest over the same range is reproducible.
 *
 * Strategies are declarative so they can be shared as plain JSON:
 *   - threshold:   buy when price <= buyBelow, sell when price >= sellAbove
 *   - ma_crossover: buy when short MA crosses above long MA, sell on the reverse
 *   - buy_and_hold: baseline
 */
import { readFileSync } from "node:fs";

export type PricePoint = { date: string; price: number };

export type Strategy =
  | { type: "threshold"; buyBelow: number; sellAbove: number }
  | { type: "ma_crossover"; shortWindow: number; longWindow: number }
  | { type: "buy_and_hold" };

export type BacktestInput = {
  strategy: Strategy;
  from: string;
  to: string;
  initialCapital: number;
  /** Fraction of trade value charged per trade, e.g. 0.001 = 0.1%. */
  feeRate?: number;
};

export type Trade = { date: string; side: "buy" | "sell"; price: number; units: number; value: number };

export type BacktestResult = {
  strategy: Strategy;
  from: string;
  to: string;
  days: number;
  initialCapital: number;
  finalValue: number;
  metrics: {
    roiPct: number;
    annualizedReturnPct: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winRatePct: number;
    benchmarkRoiPct: number;
  };
  equity: { date: string; value: number; price: number }[];
  trades: Trade[];
};

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 3 * 365;

let cachedSeries: PricePoint[] | undefined;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function generateSeries(end = new Date()): PricePoint[] {
  const rand = seeded(940);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const out: PricePoint[] = [];
  let drift = 0;
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const t = endDay - i * DAY_MS;
    const d = new Date(t);
    const dayOfYear = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS);
    drift = drift * 0.97 + (rand() - 0.5) * 0.02;
    const seasonal = 0.15 * Math.cos((2 * Math.PI * (dayOfYear - 15)) / 365);
    const weekly = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? -0.05 : 0.02;
    const price = 0.5 * (1 + seasonal + weekly + drift + (rand() - 0.5) * 0.06);
    out.push({ date: d.toISOString().slice(0, 10), price: Math.round(price * 10_000) / 10_000 });
  }
  return out;
}

export function getPriceHistory(): PricePoint[] {
  if (cachedSeries) return cachedSeries;
  const file = process.env.BACKTEST_PRICES_PATH;
  if (file) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PricePoint[];
    cachedSeries = parsed
      .filter((p) => typeof p.date === "string" && Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } else {
    cachedSeries = generateSeries();
  }
  return cachedSeries;
}

export function getPriceRange(from?: string, to?: string): PricePoint[] {
  return getPriceHistory().filter((p) => (!from || p.date >= from) && (!to || p.date <= to));
}

export function validateStrategy(s: unknown): Strategy | string {
  if (!s || typeof s !== "object") return "strategy is required";
  const o = s as Record<string, unknown>;
  switch (o.type) {
    case "threshold": {
      const buyBelow = Number(o.buyBelow);
      const sellAbove = Number(o.sellAbove);
      if (!(buyBelow > 0) || !(sellAbove > 0)) return "buyBelow and sellAbove must be positive numbers";
      if (buyBelow >= sellAbove) return "buyBelow must be less than sellAbove";
      return { type: "threshold", buyBelow, sellAbove };
    }
    case "ma_crossover": {
      const shortWindow = Number(o.shortWindow);
      const longWindow = Number(o.longWindow);
      if (!Number.isInteger(shortWindow) || !Number.isInteger(longWindow) || shortWindow < 1 || longWindow > 365)
        return "windows must be integers between 1 and 365";
      if (shortWindow >= longWindow) return "shortWindow must be less than longWindow";
      return { type: "ma_crossover", shortWindow, longWindow };
    }
    case "buy_and_hold":
      return { type: "buy_and_hold" };
    default:
      return "strategy.type must be threshold, ma_crossover or buy_and_hold";
  }
}

function signals(strategy: Strategy, prices: number[]): ("buy" | "sell" | null)[] {
  const sma = (end: number, w: number) => {
    if (end + 1 < w) return NaN;
    let sum = 0;
    for (let i = end - w + 1; i <= end; i++) sum += prices[i];
    return sum / w;
  };
  return prices.map((p, i) => {
    switch (strategy.type) {
      case "buy_and_hold":
        return i === 0 ? "buy" : null;
      case "threshold":
        return p <= strategy.buyBelow ? "buy" : p >= strategy.sellAbove ? "sell" : null;
      case "ma_crossover": {
        if (i === 0) return null;
        const prevDiff = sma(i - 1, strategy.shortWindow) - sma(i - 1, strategy.longWindow);
        const diff = sma(i, strategy.shortWindow) - sma(i, strategy.longWindow);
        if (Number.isNaN(prevDiff) || Number.isNaN(diff)) return null;
        if (prevDiff <= 0 && diff > 0) return "buy";
        if (prevDiff >= 0 && diff < 0) return "sell";
        return null;
      }
    }
  });
}

const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

export function runBacktest(input: BacktestInput, series = getPriceRange(input.from, input.to)): BacktestResult {
  const { strategy, initialCapital } = input;
  const feeRate = input.feeRate ?? 0;
  const prices = series.map((p) => p.price);
  const sig = signals(strategy, prices);

  let cash = initialCapital;
  let units = 0;
  let entryCost = 0;
  let wins = 0;
  let closed = 0;
  const trades: Trade[] = [];
  const equity: BacktestResult["equity"] = [];

  series.forEach((point, i) => {
    if (sig[i] === "buy" && units === 0 && cash > 0) {
      const spend = cash;
      units = (spend * (1 - feeRate)) / point.price;
      entryCost = spend;
      cash = 0;
      trades.push({ date: point.date, side: "buy", price: point.price, units: round(units, 4), value: round(spend) });
    } else if (sig[i] === "sell" && units > 0) {
      const proceeds = units * point.price * (1 - feeRate);
      if (proceeds > entryCost) wins++;
      closed++;
      trades.push({ date: point.date, side: "sell", price: point.price, units: round(units, 4), value: round(proceeds) });
      cash = proceeds;
      units = 0;
    }
    equity.push({ date: point.date, value: round(cash + units * point.price), price: point.price });
  });

  const finalValue = equity.length ? equity[equity.length - 1].value : initialCapital;
  const days = series.length;

  const dailyReturns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].value;
    if (prev > 0) dailyReturns.push(equity[i].value / prev - 1);
  }
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
  const variance = dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (dailyReturns.length - 1 || 1);
  const std = Math.sqrt(variance);
  const sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - e.value) / peak);
  }

  const roi = finalValue / initialCapital - 1;
  const years = days / 365;
  const benchmark = prices.length ? prices[prices.length - 1] / prices[0] - 1 : 0;

  return {
    strategy,
    from: series[0]?.date ?? input.from,
    to: series[series.length - 1]?.date ?? input.to,
    days,
    initialCapital,
    finalValue: round(finalValue),
    metrics: {
      roiPct: round(roi * 100),
      annualizedReturnPct: years > 0 && finalValue > 0 ? round(((1 + roi) ** (1 / years) - 1) * 100) : 0,
      sharpeRatio: round(sharpeRatio),
      maxDrawdownPct: round(maxDrawdown * 100),
      tradeCount: trades.length,
      winRatePct: closed ? round((wins / closed) * 100) : 0,
      benchmarkRoiPct: round(benchmark * 100),
    },
    equity,
    trades,
  };
}

/** Strategies are shared as a URL-safe token so no server-side storage is needed. */
export function encodeStrategy(strategy: Strategy): string {
  return Buffer.from(JSON.stringify(strategy)).toString("base64url");
}

export function decodeStrategy(token: string): Strategy | string {
  try {
    return validateStrategy(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  } catch {
    return "invalid strategy token";
  }
}
