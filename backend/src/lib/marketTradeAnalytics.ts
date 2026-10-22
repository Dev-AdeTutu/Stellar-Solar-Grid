/**
 * P2P energy trading market analytics (#999).
 *
 * Aggregates the in-memory offers/matches from p2pTrading.ts (the actual
 * P2P order book) into the market-data traders need to price fairly: a
 * volume-weighted average price, traded volume, a liquidity indicator from
 * the open order book, supply/demand depth, and price history at hourly,
 * daily and weekly granularity.
 */
import { getAllMatches, getOpenOffers, type TradeMatch } from "./p2pTrading.js";

export type PricePoint = { bucket: string; avgPrice: number; volumeKwh: number; trades: number };

export type MarketTradeAnalytics = {
  generatedAt: string;
  avgPrice: number | null;
  totalVolumeKwh: number;
  totalVolumeXlm: number;
  tradeCount: number;
  supplyKwh: number;
  demandKwh: number;
  /** 0–1; the smaller side of the open order book as a fraction of the larger. 0 when either side is empty. */
  liquidity: number;
  priceHistory: { hourly: PricePoint[]; daily: PricePoint[]; weekly: PricePoint[] };
};

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

function weekStart(iso: string): string {
  const d = new Date(iso);
  const isoDay = d.getUTCDay() || 7; // Monday = 1 .. Sunday = 7
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - isoDay + 1);
  return monday.toISOString().slice(0, 10);
}

function bucketKey(iso: string, grain: "hour" | "day" | "week"): string {
  if (grain === "hour") return iso.slice(0, 13);
  if (grain === "day") return iso.slice(0, 10);
  return weekStart(iso);
}

function buildHistory(matches: TradeMatch[], grain: "hour" | "day" | "week"): PricePoint[] {
  const buckets = new Map<string, { valueXlm: number; volumeKwh: number; trades: number }>();
  for (const m of matches) {
    const key = bucketKey(m.matchedAt, grain);
    const b = buckets.get(key) ?? { valueXlm: 0, volumeKwh: 0, trades: 0 };
    b.valueXlm += m.totalXlm;
    b.volumeKwh += m.energyKwh;
    b.trades += 1;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, b]) => ({
      bucket,
      avgPrice: b.volumeKwh > 0 ? round4(b.valueXlm / b.volumeKwh) : 0,
      volumeKwh: round4(b.volumeKwh),
      trades: b.trades,
    }));
}

/** Matches that represent real traded volume (excludes disputed trades, which may still reverse). */
function tradedMatches(): TradeMatch[] {
  return getAllMatches().filter((m) => m.status === "matched" || m.status === "settled");
}

export function computeTradeAnalytics(now = new Date()): MarketTradeAnalytics {
  const matches = tradedMatches();
  const supplyKwh = getOpenOffers("sell").reduce((s, o) => s + o.energyKwh, 0);
  const demandKwh = getOpenOffers("buy").reduce((s, o) => s + o.energyKwh, 0);
  const liquidity = supplyKwh > 0 && demandKwh > 0 ? round4(Math.min(supplyKwh, demandKwh) / Math.max(supplyKwh, demandKwh)) : 0;
  const totalValueXlm = matches.reduce((s, m) => s + m.totalXlm, 0);
  const totalVolumeKwh = matches.reduce((s, m) => s + m.energyKwh, 0);
  return {
    generatedAt: now.toISOString(),
    avgPrice: totalVolumeKwh > 0 ? round4(totalValueXlm / totalVolumeKwh) : null,
    totalVolumeKwh: round4(totalVolumeKwh),
    totalVolumeXlm: round4(totalValueXlm),
    tradeCount: matches.length,
    supplyKwh: round4(supplyKwh),
    demandKwh: round4(demandKwh),
    liquidity,
    priceHistory: {
      hourly: buildHistory(matches, "hour"),
      daily: buildHistory(matches, "day"),
      weekly: buildHistory(matches, "week"),
    },
  };
}
