/**
 * Client for the energy trading analytics API (#873).
 */
import { env } from "@/lib/env";

export type Range = "7d" | "30d" | "90d";
export const RANGES: Range[] = ["7d", "30d", "90d"];

export type DailyPoint = {
  date: string;
  energyKwh: number;
  valueStroops: number;
  trades: number;
  activeMeters: number;
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  movingAvgPrice: number | null;
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
  forecast: {
    horizonDays: number;
    slopePerDay: number | null;
    r2: number | null;
    points: Array<{ date: string; price: number; lower: number; upper: number }>;
    reason?: string;
  };
  hourly: Array<{ hour: number; energyKwh: number; trades: number }>;
  weekday: Array<{ weekday: number; energyKwh: number; trades: number }>;
  topMeters: Array<{ meterId: string; energyKwh: number; valueStroops: number; sharePct: number }>;
  insights: string[];
};

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/analytics/market`;

function query(range: Range, meterId?: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ range, ...extra });
  if (meterId?.trim()) params.set("meter_id", meterId.trim());
  return params.toString();
}

export async function fetchMarketAnalytics(range: Range, meterId?: string): Promise<MarketAnalytics> {
  const res = await fetch(`${API}?${query(range, meterId)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as MarketAnalytics;
}

export function exportUrl(range: Range, format: "csv" | "pdf", meterId?: string): string {
  return `${API}/export?${query(range, meterId, { format })}`;
}

const STROOPS_PER_XLM = 10_000_000;

/** Price in stroops/kWh rendered as XLM per kWh. */
export function formatPrice(stroopsPerKwh: number | null): string {
  if (stroopsPerKwh == null) return "–";
  return `${(stroopsPerKwh / STROOPS_PER_XLM).toLocaleString(undefined, { maximumFractionDigits: 5 })} XLM/kWh`;
}

export function formatXlm(stroops: number): string {
  return `${(stroops / STROOPS_PER_XLM).toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM`;
}

export function formatKwh(kwh: number): string {
  return `${kwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
}

export function formatChange(pct: number | null): string {
  if (pct == null) return "no prior data";
  if (Math.abs(pct) < 0.05) return "0% vs prior period";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}% vs prior period`;
}

/** Actual daily prices followed by the forecast, shaped for one price chart. */
export function priceSeries(a: MarketAnalytics) {
  const actual = a.daily.map((d) => ({
    date: d.date,
    price: d.avgPrice,
    movingAvg: d.movingAvgPrice,
    forecast: null as number | null,
    band: null as [number, number] | null,
  }));
  // Start the forecast line at the last actual price so the two connect.
  const last = [...actual].reverse().find((p) => p.price != null);
  if (last && a.forecast.points.length) {
    last.forecast = last.price;
    last.band = [last.price as number, last.price as number];
  }
  const forecast = a.forecast.points.map((p) => ({
    date: p.date,
    price: null,
    movingAvg: null,
    forecast: p.price,
    band: [p.lower, p.upper] as [number, number],
  }));
  return [...actual, ...forecast];
}
