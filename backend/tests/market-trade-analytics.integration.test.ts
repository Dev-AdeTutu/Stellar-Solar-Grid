/**
 * P2P energy trading market analytics (#999).
 *
 * p2pTrading.ts keeps its offers/matches in module-level Maps, so each test
 * file gets its own fresh state simply by being its own module instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import * as trading from "../src/lib/p2pTrading";
import { computeTradeAnalytics } from "../src/lib/marketTradeAnalytics";
import { marketTradeAnalyticsRouter } from "../src/routes/marketTradeAnalytics";

let server: Server;
let base: string;

beforeAll(async () => {
  // Two settled trades an hour apart, plus one open offer on each side so
  // supply/demand and liquidity have something to report.
  trading.createOffer({ userId: "seller1", direction: "sell", energyKwh: 10, pricePerKwh: 0.2, meterId: "M1" });
  trading.createOffer({ userId: "buyer1", direction: "buy", energyKwh: 10, pricePerKwh: 0.2, meterId: "M2" });
  const [match1] = trading.runMatchingAlgorithm();
  trading.settleMatch(match1.id);

  trading.createOffer({ userId: "seller2", direction: "sell", energyKwh: 4, pricePerKwh: 0.3, meterId: "M3" });
  trading.createOffer({ userId: "buyer2", direction: "buy", energyKwh: 4, pricePerKwh: 0.3, meterId: "M4" });
  const [match2] = trading.runMatchingAlgorithm();
  trading.settleMatch(match2.id);

  // Unmatched open offers remain in the book as supply/demand depth.
  trading.createOffer({ userId: "seller3", direction: "sell", energyKwh: 7, pricePerKwh: 0.5 });
  trading.createOffer({ userId: "buyer3", direction: "buy", energyKwh: 3, pricePerKwh: 0.1 });

  const app = express();
  app.use("/api/market/analytics", marketTradeAnalyticsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market/analytics`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("computeTradeAnalytics", () => {
  it("aggregates volume, value and average price from settled trades", () => {
    const a = computeTradeAnalytics();
    expect(a.tradeCount).toBe(2);
    expect(a.totalVolumeKwh).toBe(14);
    // match1: 10 kWh @ 0.2, match2: 4 kWh @ 0.3 → total value = 2 + 1.2 = 3.2, avg = 3.2/14.
    expect(a.totalVolumeXlm).toBeCloseTo(3.2, 2);
    expect(a.avgPrice).toBeCloseTo(3.2 / 14, 4);
  });

  it("reports supply, demand and liquidity from the open order book", () => {
    const a = computeTradeAnalytics();
    expect(a.supplyKwh).toBe(7);
    expect(a.demandKwh).toBe(3);
    expect(a.liquidity).toBeCloseTo(3 / 7, 4);
  });

  it("buckets price history by hour, day and week", () => {
    const a = computeTradeAnalytics();
    expect(a.priceHistory.hourly.length).toBeGreaterThan(0);
    expect(a.priceHistory.daily.length).toBeGreaterThan(0);
    expect(a.priceHistory.weekly.length).toBeGreaterThan(0);
    const dailyTotal = a.priceHistory.daily.reduce((s, p) => s + p.trades, 0);
    expect(dailyTotal).toBe(2);
  });
});

describe("GET /api/market/analytics", () => {
  it("serves the current snapshot", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tradeCount).toBe(2);
    expect(body.priceHistory).toHaveProperty("hourly");
    expect(body.priceHistory).toHaveProperty("daily");
    expect(body.priceHistory).toHaveProperty("weekly");
  });
});
