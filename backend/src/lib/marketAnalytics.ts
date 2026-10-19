/**
 * Energy trading analytics (#873).
 *
 * Every usage event is a trade: `units` milli-kWh of energy sold for `cost`
 * stroops. Detailed events older than the retention window are compacted
 * into daily per-meter rows in `usage_summary`, so both tables are read and
 * merged per UTC day.
 *
 * Performance: all aggregation happens in SQLite (GROUP BY over indexed
 * ranges), so the work in JS is bounded by the number of days (<= 90), hours
 * (24) and top meters (10), not by the number of events.
 *
 * Prices are volume-weighted and expressed in stroops per kWh.
 */
import type Database from "better-sqlite3";
import { createPagedTextPdf, type PagedPdfLine } from "./pdf.js";

type Db = InstanceType<typeof Database>;

export const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type Range = keyof typeof RANGES;

export const FORECAST_DAYS = 7;
const DAY_MS = 86_400_000;

export type DailyPoint = {
  date: string;
  energyKwh: number;
  valueStroops: number;
  trades: number;
  activeMeters: number;
  /** Volume-weighted average price (stroops/kWh); null on days without trades. */
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** Trailing 7-day volume-weighted price. */
  movingAvgPrice: number | null;
};

export type ForecastPoint = { date: string; price: number; lower: number; upper: number };

export type Forecast = {
  method: "linear-regression";
  horizonDays: number;
  slopePerDay: number | null;
  r2: number | null;
  points: ForecastPoint[];
  /** Why no forecast was produced, when `points` is empty. */
  reason?: string;
};

export type MarketAnalytics = {
  range: Range;
  meterId: string | null;
  from: string;
  to: string;
  generatedAt: string;
  summary: {
    totalEnergyKwh: number;
    totalValueStroops: number;
    trades: number;
    activeMeters: number;
    avgPrice: number | null;
    avgTradeKwh: number | null;
    priceVolatilityPct: number | null;
    priceChangePct: number | null;
    volumeChangePct: number | null;
    peakDay: { date: string; energyKwh: number } | null;
  };
  daily: DailyPoint[];
  forecast: Forecast;
  hourly: Array<{ hour: number; energyKwh: number; trades: number }>;
  weekday: Array<{ weekday: number; energyKwh: number; trades: number }>;
  topMeters: Array<{ meterId: string; energyKwh: number; valueStroops: number; sharePct: number }>;
  insights: string[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const price = (costStroops: number, units: number) => (units > 0 ? (costStroops * 1000) / units : null);
const pct = (current: number | null, previous: number | null) =>
  current == null || previous == null || previous === 0 ? null : round(((current - previous) / previous) * 100, 1);

/** `[from, to)` covering the last `days` UTC days, including today. */
export function periodBounds(range: Range, now = new Date()): { from: Date; to: Date; days: number } {
  const days = RANGES[range];
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { from: new Date(to.getTime() - days * DAY_MS), to, days };
}

export function isRange(value: unknown): value is Range {
  return typeof value === "string" && value in RANGES;
}

/** Least-squares line through (x, y) with R². */
export function linearRegression(points: Array<{ x: number; y: number }>) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.x - meanX) ** 2, 0);
  const sxy = points.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const sse = points.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const sst = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  return { slope, intercept, r2: sst === 0 ? 1 : 1 - sse / sst, sse, sxx, meanX, n };
}

/** 7-day linear forecast of the daily price with a 95% prediction band. */
export function forecastPrices(daily: DailyPoint[], horizon = FORECAST_DAYS): Forecast {
  const series = daily
    .map((d, i) => ({ x: i, y: d.avgPrice }))
    .filter((p): p is { x: number; y: number } => p.y != null);
  const base = { method: "linear-regression" as const, horizonDays: horizon };
  if (series.length < 3) {
    return { ...base, slopePerDay: null, r2: null, points: [], reason: "At least 3 days with trades are needed" };
  }
  const fit = linearRegression(series);
  const se = series.length > 2 ? Math.sqrt(fit.sse / (series.length - 2)) : 0;
  const lastDate = new Date(`${daily[daily.length - 1].date}T00:00:00Z`).getTime();
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const x = daily.length - 1 + h;
    const y = Math.max(0, fit.intercept + fit.slope * x);
    const spread =
      1.96 * se * Math.sqrt(1 + 1 / fit.n + (fit.sxx === 0 ? 0 : (x - fit.meanX) ** 2 / fit.sxx));
    points.push({
      date: new Date(lastDate + h * DAY_MS).toISOString().slice(0, 10),
      price: round(y),
      lower: round(Math.max(0, y - spread)),
      upper: round(y + spread),
    });
  }
  return { ...base, slopePerDay: round(fit.slope, 4), r2: round(fit.r2, 3), points };
}

// ── Queries ──────────────────────────────────────────────────────────────────

const ensuredIndexes = new WeakSet<Db>();

/** Range scans without a meter filter need an index on received_at. */
function ensureIndexes(db: Db) {
  if (ensuredIndexes.has(db)) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_events_received_at ON usage_events (received_at);
    CREATE INDEX IF NOT EXISTS idx_usage_summary_date ON usage_summary (date);
  `);
  ensuredIndexes.add(db);
}

type Window = { from: Date; to: Date; meterId: string | null };

function filters(w: Window) {
  const meter = w.meterId ? " AND meter_id = ?" : "";
  const detail = {
    where: `received_at >= ? AND received_at < ? AND status != 'failed' AND units > 0${meter}`,
    params: [w.from.toISOString(), w.to.toISOString(), ...(w.meterId ? [w.meterId] : [])],
  };
  const summary = {
    where: `date >= ? AND date < ?${meter}`,
    params: [w.from.toISOString().slice(0, 10), w.to.toISOString().slice(0, 10), ...(w.meterId ? [w.meterId] : [])],
  };
  return { detail, summary };
}

function totals(db: Db, w: Window) {
  const f = filters(w);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS units, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(trades), 0) AS trades FROM (
         SELECT SUM(units) AS units, SUM(CAST(cost AS INTEGER)) AS cost, COUNT(*) AS trades FROM usage_events WHERE ${f.detail.where}
         UNION ALL
         SELECT SUM(total_units), SUM(total_cost), SUM(event_count) FROM usage_summary WHERE ${f.summary.where}
       )`,
    )
    .get(...f.detail.params, ...f.summary.params) as { units: number; cost: number; trades: number };
  return row;
}

export function computeMarketAnalytics(
  db: Db,
  options: { range: Range; meterId?: string | null; now?: Date },
): MarketAnalytics {
  ensureIndexes(db);
  const now = options.now ?? new Date();
  const { from, to, days } = periodBounds(options.range, now);
  const window: Window = { from, to, meterId: options.meterId ?? null };
  const f = filters(window);

  type DayRow = { day: string; units: number; cost: number; trades: number; meters: number; min_price: number | null; max_price: number | null };
  const detailRows = db
    .prepare(
      `SELECT substr(received_at, 1, 10) AS day, SUM(units) AS units, SUM(CAST(cost AS INTEGER)) AS cost,
              COUNT(*) AS trades, COUNT(DISTINCT meter_id) AS meters,
              MIN(CAST(cost AS REAL) * 1000.0 / units) AS min_price,
              MAX(CAST(cost AS REAL) * 1000.0 / units) AS max_price
       FROM usage_events WHERE ${f.detail.where} GROUP BY day`,
    )
    .all(...f.detail.params) as DayRow[];
  const summaryRows = db
    .prepare(
      `SELECT date AS day, SUM(total_units) AS units, SUM(total_cost) AS cost, SUM(event_count) AS trades,
              COUNT(DISTINCT meter_id) AS meters, NULL AS min_price, NULL AS max_price
       FROM usage_summary WHERE ${f.summary.where} GROUP BY date`,
    )
    .all(...f.summary.params) as DayRow[];

  const byDay = new Map<string, DayRow>();
  for (const r of [...detailRows, ...summaryRows]) {
    const prev = byDay.get(r.day);
    if (!prev) {
      byDay.set(r.day, { ...r });
      continue;
    }
    // A day can straddle compaction: merge its detailed and summarized parts.
    byDay.set(r.day, {
      day: r.day,
      units: prev.units + r.units,
      cost: prev.cost + r.cost,
      trades: prev.trades + r.trades,
      meters: Math.max(prev.meters, r.meters),
      min_price: prev.min_price ?? r.min_price,
      max_price: prev.max_price ?? r.max_price,
    });
  }

  // Dense calendar series so charts show gaps as zero-volume days.
  const daily: DailyPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(from.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    const r = byDay.get(date);
    const avg = r ? price(r.cost, r.units) : null;
    daily.push({
      date,
      energyKwh: r ? round(r.units / 1000, 3) : 0,
      valueStroops: r?.cost ?? 0,
      trades: r?.trades ?? 0,
      activeMeters: r?.meters ?? 0,
      avgPrice: avg == null ? null : round(avg),
      minPrice: r?.min_price == null ? avg == null ? null : round(avg) : round(r.min_price),
      maxPrice: r?.max_price == null ? avg == null ? null : round(avg) : round(r.max_price),
      movingAvgPrice: null,
    });
  }
  for (let i = 0; i < daily.length; i++) {
    const windowDays = daily.slice(Math.max(0, i - 6), i + 1);
    const units = windowDays.reduce((s, d) => s + d.energyKwh * 1000, 0);
    const cost = windowDays.reduce((s, d) => s + d.valueStroops, 0);
    const ma = price(cost, units);
    daily[i].movingAvgPrice = ma == null ? null : round(ma);
  }

  const activeMeters = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT meter_id FROM usage_events WHERE ${f.detail.where}
           UNION SELECT meter_id FROM usage_summary WHERE ${f.summary.where})`,
      )
      .get(...f.detail.params, ...f.summary.params) as { n: number }
  ).n;

  const hourlyRows = db
    .prepare(
      `SELECT CAST(substr(received_at, 12, 2) AS INTEGER) AS hour, SUM(units) AS units, COUNT(*) AS trades
       FROM usage_events WHERE ${f.detail.where} GROUP BY hour`,
    )
    .all(...f.detail.params) as Array<{ hour: number; units: number; trades: number }>;
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const r = hourlyRows.find((h) => h.hour === hour);
    return { hour, energyKwh: r ? round(r.units / 1000, 3) : 0, trades: r?.trades ?? 0 };
  });

  const weekday = Array.from({ length: 7 }, (_, wd) => ({ weekday: wd, energyKwh: 0, trades: 0 }));
  for (const d of daily) {
    const wd = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    weekday[wd].energyKwh = round(weekday[wd].energyKwh + d.energyKwh, 3);
    weekday[wd].trades += d.trades;
  }

  const topRows = db
    .prepare(
      `SELECT meter_id, SUM(units) AS units, SUM(cost) AS cost FROM (
         SELECT meter_id, units, CAST(cost AS INTEGER) AS cost FROM usage_events WHERE ${f.detail.where}
         UNION ALL
         SELECT meter_id, total_units, total_cost FROM usage_summary WHERE ${f.summary.where})
       GROUP BY meter_id ORDER BY units DESC LIMIT 10`,
    )
    .all(...f.detail.params, ...f.summary.params) as Array<{ meter_id: string; units: number; cost: number }>;

  const current = totals(db, window);
  const previous = totals(db, { ...window, from: new Date(from.getTime() - days * DAY_MS), to: from });
  const totalKwh = current.units / 1000;
  const topMeters = topRows.map((r) => ({
    meterId: r.meter_id,
    energyKwh: round(r.units / 1000, 3),
    valueStroops: r.cost,
    sharePct: current.units > 0 ? round((r.units / current.units) * 100, 1) : 0,
  }));

  const prices = daily.map((d) => d.avgPrice).filter((p): p is number => p != null);
  const meanPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null;
  const volatility =
    meanPrice && prices.length > 1
      ? round((Math.sqrt(prices.reduce((s, p) => s + (p - meanPrice) ** 2, 0) / (prices.length - 1)) / meanPrice) * 100, 1)
      : null;
  const avgPrice = price(current.cost, current.units);
  const peak = daily.reduce<DailyPoint | null>((best, d) => (d.energyKwh > (best?.energyKwh ?? 0) ? d : best), null);

  const summary = {
    totalEnergyKwh: round(totalKwh, 3),
    totalValueStroops: current.cost,
    trades: current.trades,
    activeMeters,
    avgPrice: avgPrice == null ? null : round(avgPrice),
    avgTradeKwh: current.trades > 0 ? round(totalKwh / current.trades, 3) : null,
    priceVolatilityPct: volatility,
    priceChangePct: pct(avgPrice, price(previous.cost, previous.units)),
    volumeChangePct: pct(current.units, previous.units),
    peakDay: peak ? { date: peak.date, energyKwh: peak.energyKwh } : null,
  };
  const forecast = forecastPrices(daily);

  return {
    range: options.range,
    meterId: window.meterId,
    from: from.toISOString(),
    to: to.toISOString(),
    generatedAt: now.toISOString(),
    summary,
    daily,
    forecast,
    hourly,
    weekday,
    topMeters,
    insights: buildInsights(options.range, summary, forecast, hourly, weekday, topMeters),
  };
}

// ── Insights ─────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function change(label: string, value: number | null, period: string): string | null {
  if (value == null) return null;
  if (Math.abs(value) < 1) return `${label} was flat compared with the previous ${period}.`;
  return `${label} ${value > 0 ? "rose" : "fell"} ${Math.abs(value).toFixed(1)}% compared with the previous ${period}.`;
}

function buildInsights(
  range: Range,
  summary: MarketAnalytics["summary"],
  forecast: Forecast,
  hourly: MarketAnalytics["hourly"],
  weekday: MarketAnalytics["weekday"],
  topMeters: MarketAnalytics["topMeters"],
): string[] {
  if (summary.trades === 0) return ["No trades were recorded in this period."];
  const period = `${RANGES[range]} days`;
  const out: Array<string | null> = [
    change("The average price", summary.priceChangePct, period),
    change("Traded volume", summary.volumeChangePct, period),
  ];

  if (forecast.points.length && forecast.r2 != null && summary.avgPrice) {
    const last = forecast.points[forecast.points.length - 1].price;
    const move = ((last - summary.avgPrice) / summary.avgPrice) * 100;
    out.push(
      forecast.r2 >= 0.3 && Math.abs(move) >= 1
        ? `Prices are forecast to ${move > 0 ? "rise" : "fall"} about ${Math.abs(move).toFixed(1)}% over the next ${forecast.horizonDays} days (trend fit R² ${forecast.r2}).`
        : `No reliable price trend: the forecast has low confidence (R² ${forecast.r2}).`,
    );
  }

  const busiestHour = hourly.reduce((a, b) => (b.energyKwh > a.energyKwh ? b : a));
  const hourVolume = hourly.reduce((s, h) => s + h.energyKwh, 0);
  if (hourVolume > 0) {
    const hh = String(busiestHour.hour).padStart(2, "0");
    out.push(
      `Trading peaks at ${hh}:00–${hh}:59 UTC with ${((busiestHour.energyKwh / hourVolume) * 100).toFixed(1)}% of intraday volume.`,
    );
  }
  const busiestDay = weekday.reduce((a, b) => (b.energyKwh > a.energyKwh ? b : a));
  if (busiestDay.energyKwh > 0) out.push(`${WEEKDAYS[busiestDay.weekday]} is the busiest trading day.`);

  if (topMeters.length >= 3) {
    const top3 = topMeters.slice(0, 3).reduce((s, m) => s + m.sharePct, 0);
    out.push(`The top 3 meters account for ${top3.toFixed(1)}% of volume${top3 >= 50 ? ", a concentrated market" : ""}.`);
  }
  if (summary.priceVolatilityPct != null && summary.priceVolatilityPct >= 25) {
    out.push(`Prices were volatile, varying ±${summary.priceVolatilityPct}% from day to day.`);
  }
  return out.filter((s): s is string => s !== null);
}

// ── Export ───────────────────────────────────────────────────────────────────

const CSV_HEADER = [
  "type",
  "date",
  "energy_kwh",
  "value_stroops",
  "trades",
  "active_meters",
  "avg_price_stroops_per_kwh",
  "min_price",
  "max_price",
  "moving_avg_7d",
  "forecast_lower",
  "forecast_upper",
];

/** Daily rows followed by the forecast, one line per day. */
export function analyticsToCsv(a: MarketAnalytics): string {
  const cell = (v: unknown) => (v == null ? "" : String(v));
  const rows = a.daily.map((d) =>
    ["actual", d.date, d.energyKwh, d.valueStroops, d.trades, d.activeMeters, d.avgPrice, d.minPrice, d.maxPrice, d.movingAvgPrice, "", ""].map(cell),
  );
  const forecastRows = a.forecast.points.map((p) =>
    ["forecast", p.date, "", "", "", "", p.price, "", "", "", p.lower, p.upper].map(cell),
  );
  return [CSV_HEADER, ...rows, ...forecastRows].map((r) => r.join(",")).join("\n") + "\n";
}

const STROOPS_PER_XLM = 10_000_000;
const xlm = (stroops: number) => `${(stroops / STROOPS_PER_XLM).toLocaleString("en-US", { maximumFractionDigits: 4 })} XLM`;
const priceLabel = (p: number | null) => (p == null ? "-" : `${xlm(p)}/kWh`);
const signed = (v: number | null) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${v}%`);
/** The standard PDF fonts only cover Latin-1; fold the few symbols insights use. */
const pdfSafe = (s: string) =>
  s.replace(/–/g, "-").replace(/²/g, "^2").replace(/±/g, "+/-").replace(/[^\x20-\x7e]/g, "?");

/** Multi-page PDF report: summary, insights, forecast and the daily table. */
export function analyticsToPdf(a: MarketAnalytics): Buffer {
  const s = a.summary;
  const col = (v: string | number, width: number) => String(v).padStart(width);
  const lines: PagedPdfLine[] = [
    { text: "Energy Trading Analytics", size: 18, bold: true },
    `Period: ${a.from.slice(0, 10)} to ${a.to.slice(0, 10)} (${RANGES[a.range]} days, UTC)${a.meterId ? ` - meter ${a.meterId}` : ""}`,
    `Generated: ${a.generatedAt}`,
    "",
    { text: "Summary", bold: true },
    `Traded volume: ${s.totalEnergyKwh.toLocaleString("en-US")} kWh (${signed(s.volumeChangePct)} vs previous period)`,
    `Traded value: ${xlm(s.totalValueStroops)}`,
    `Average price: ${priceLabel(s.avgPrice)} (${signed(s.priceChangePct)} vs previous period)`,
    `Trades: ${s.trades.toLocaleString("en-US")} - active meters: ${s.activeMeters}`,
    `Price volatility: ${s.priceVolatilityPct == null ? "n/a" : `${s.priceVolatilityPct}%`}`,
    "",
    { text: "Market insights", bold: true },
    ...a.insights.map((i) => `- ${pdfSafe(i)}`),
    "",
    { text: `Price forecast (next ${a.forecast.horizonDays} days)`, bold: true },
    ...(a.forecast.points.length
      ? a.forecast.points.map((p) => ({
          text: `${p.date}  ${col(p.price.toFixed(0), 12)}  [${p.lower.toFixed(0)} - ${p.upper.toFixed(0)}] stroops/kWh`,
          mono: true,
          size: 9,
        }))
      : [a.forecast.reason ?? "Not enough data"]),
    "",
    { text: "Daily market data", bold: true },
    {
      text: `${"date".padEnd(10)} ${col("kWh", 12)} ${col("trades", 7)} ${col("meters", 6)} ${col("avg/kWh", 12)} ${col("7d avg", 12)}`,
      mono: true,
      size: 9,
    },
    ...a.daily.map((d) => ({
      text: `${d.date} ${col(d.energyKwh, 12)} ${col(d.trades, 7)} ${col(d.activeMeters, 6)} ${col(d.avgPrice ?? "-", 12)} ${col(d.movingAvgPrice ?? "-", 12)}`,
      mono: true,
      size: 9,
    })),
    "",
    { text: "Prices are volume-weighted, in stroops per kWh (1 XLM = 10,000,000 stroops).", size: 8 },
  ];
  return createPagedTextPdf(lines);
}
