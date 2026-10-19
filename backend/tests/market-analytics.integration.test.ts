/**
 * Energy trading analytics (#873).
 *
 * Runs against an in-memory SQLite database with the production schema, so
 * the SQL aggregation, merging of compacted summaries and export formats are
 * exercised end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import Database from "better-sqlite3";
import {
  analyticsToCsv,
  analyticsToPdf,
  computeMarketAnalytics,
  forecastPrices,
  linearRegression,
  periodBounds,
  type DailyPoint,
} from "../src/lib/marketAnalytics";
import { createMarketAnalyticsRouter } from "../src/routes/marketAnalytics";

const NOW = new Date("2026-09-28T15:00:00.000Z");

function schema(db: InstanceType<typeof Database>) {
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meter_id TEXT NOT NULL, units INTEGER NOT NULL, cost TEXT NOT NULL,
      received_at TEXT NOT NULL, source_topic TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, last_error TEXT,
      on_chain_tx_hash TEXT, submitted_at TEXT);
    CREATE TABLE usage_summary (
      date TEXT NOT NULL, meter_id TEXT NOT NULL, total_units INTEGER NOT NULL DEFAULT 0,
      total_cost INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, meter_id));
  `);
}

function trade(db: InstanceType<typeof Database>, meter: string, at: string, units: number, cost: number, status = "submitted") {
  db.prepare("INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, ?, ?, ?)").run(
    meter,
    units,
    String(cost),
    at,
    status,
  );
}

/** Deterministic market: price climbs 100 stroops/kWh per day, peak at 18:00 UTC. */
function seedMarket() {
  const db = new Database(":memory:");
  schema(db);
  for (let d = 0; d < 7; d++) {
    const day = new Date(Date.UTC(2026, 8, 22 + d)).toISOString().slice(0, 10);
    const pricePerKwh = 10_000 + d * 100;
    // meter A: 2 kWh at 18:00, meter B: 1 kWh at 09:00 (units are milli-kWh)
    trade(db, "A", `${day}T18:05:00.000Z`, 2_000, 2 * pricePerKwh);
    trade(db, "B", `${day}T09:30:00.000Z`, 1_000, pricePerKwh);
  }
  // Failed submissions and zero-unit rows are ignored.
  trade(db, "A", "2026-09-28T10:00:00.000Z", 50_000, 1, "failed");
  trade(db, "C", "2026-09-28T11:00:00.000Z", 0, 999);
  // Previous 7-day period: 3 kWh per day at 9_000 stroops/kWh.
  for (let d = 0; d < 7; d++) {
    const day = new Date(Date.UTC(2026, 8, 15 + d)).toISOString().slice(0, 10);
    trade(db, "A", `${day}T12:00:00.000Z`, 3_000, 27_000);
  }
  return db;
}

describe("statistics helpers", () => {
  it("fits a regression line", () => {
    const fit = linearRegression([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
    ]);
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.intercept).toBeCloseTo(1);
    expect(fit.r2).toBeCloseTo(1);
  });

  it("requires three priced days to forecast", () => {
    const day = (date: string, avgPrice: number | null): DailyPoint => ({
      date, energyKwh: 1, valueStroops: 1, trades: 1, activeMeters: 1, avgPrice, minPrice: avgPrice, maxPrice: avgPrice, movingAvgPrice: avgPrice,
    });
    expect(forecastPrices([day("2026-01-01", 1), day("2026-01-02", null), day("2026-01-03", 2)]).points).toEqual([]);
    const f = forecastPrices([day("2026-01-01", 10), day("2026-01-02", 20), day("2026-01-03", 30)]);
    expect(f.points).toHaveLength(7);
    expect(f.points[0]).toMatchObject({ date: "2026-01-04", price: 40 });
    expect(f.points[6].price).toBe(100);
  });

  it("covers whole UTC days including today", () => {
    const { from, to, days } = periodBounds("7d", NOW);
    expect(days).toBe(7);
    expect(from.toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });
});

describe("computeMarketAnalytics", () => {
  const db = seedMarket();
  const a = computeMarketAnalytics(db, { range: "7d", now: NOW });

  it("aggregates volume, value and volume-weighted prices", () => {
    expect(a.daily).toHaveLength(7);
    expect(a.summary.totalEnergyKwh).toBe(21);
    expect(a.summary.trades).toBe(14);
    expect(a.summary.activeMeters).toBe(2);
    // VWAP over 7 days of prices 10_000..10_600 with equal volume = 10_300.
    expect(a.summary.avgPrice).toBe(10_300);
    expect(a.daily[0]).toMatchObject({ date: "2026-09-22", energyKwh: 3, trades: 2, activeMeters: 2, avgPrice: 10_000 });
    expect(a.daily[6].avgPrice).toBe(10_600);
    expect(a.daily[6].minPrice).toBe(10_600);
  });

  it("compares with the previous period", () => {
    // Previous period: 21 kWh at 9_000/kWh.
    expect(a.summary.volumeChangePct).toBe(0);
    expect(a.summary.priceChangePct).toBeCloseTo(14.4, 1);
  });

  it("computes the trailing 7-day moving average", () => {
    expect(a.daily[0].movingAvgPrice).toBe(10_000);
    expect(a.daily[1].movingAvgPrice).toBe(10_050);
    expect(a.daily[6].movingAvgPrice).toBe(10_300);
  });

  it("forecasts the linear price trend", () => {
    expect(a.forecast.r2).toBe(1);
    expect(a.forecast.slopePerDay).toBe(100);
    expect(a.forecast.points[0]).toMatchObject({ date: "2026-09-29", price: 10_700 });
    expect(a.forecast.points[0].lower).toBeLessThanOrEqual(10_700);
    expect(a.forecast.points[0].upper).toBeGreaterThanOrEqual(10_700);
  });

  it("finds intraday and weekly trading patterns", () => {
    expect(a.hourly).toHaveLength(24);
    expect(a.hourly[18]).toEqual({ hour: 18, energyKwh: 14, trades: 7 });
    expect(a.hourly[9]).toEqual({ hour: 9, energyKwh: 7, trades: 7 });
    expect(a.weekday.reduce((s, w) => s + w.trades, 0)).toBe(14);
  });

  it("ranks top meters by volume share", () => {
    expect(a.topMeters).toEqual([
      { meterId: "A", energyKwh: 14, valueStroops: 144_200, sharePct: 66.7 },
      { meterId: "B", energyKwh: 7, valueStroops: 72_100, sharePct: 33.3 },
    ]);
  });

  it("writes human-readable market insights", () => {
    expect(a.insights).toContain("The average price rose 14.4% compared with the previous 7 days.");
    expect(a.insights).toContain("Traded volume was flat compared with the previous 7 days.");
    expect(a.insights.some((i) => i.startsWith("Prices are forecast to rise"))).toBe(true);
    expect(a.insights.some((i) => i.includes("18:00"))).toBe(true);
  });

  it("filters by meter", () => {
    const b = computeMarketAnalytics(db, { range: "7d", meterId: "B", now: NOW });
    expect(b.summary.totalEnergyKwh).toBe(7);
    expect(b.topMeters.map((m) => m.meterId)).toEqual(["B"]);
    expect(b.summary.volumeChangePct).toBeNull(); // B had no previous-period trades
  });

  it("merges compacted daily summaries with detailed events", () => {
    const merged = seedMarket();
    merged
      .prepare("INSERT INTO usage_summary (date, meter_id, total_units, total_cost, event_count) VALUES (?, ?, ?, ?, ?)")
      .run("2026-09-22", "Z", 1_000, 10_000, 5);
    const m = computeMarketAnalytics(merged, { range: "7d", now: NOW });
    expect(m.daily[0]).toMatchObject({ energyKwh: 4, trades: 7 });
    expect(m.summary.activeMeters).toBe(3);
    expect(m.summary.totalEnergyKwh).toBe(22);
  });

  it("handles an empty market", () => {
    const empty = new Database(":memory:");
    schema(empty);
    const e = computeMarketAnalytics(empty, { range: "30d", now: NOW });
    expect(e.daily).toHaveLength(30);
    expect(e.summary.avgPrice).toBeNull();
    expect(e.forecast.points).toEqual([]);
    expect(e.insights).toEqual(["No trades were recorded in this period."]);
  });

  it("exports CSV with actual and forecast rows", () => {
    const csv = analyticsToCsv(a).trim().split("\n");
    expect(csv[0]).toBe(
      "type,date,energy_kwh,value_stroops,trades,active_meters,avg_price_stroops_per_kwh,min_price,max_price,moving_avg_7d,forecast_lower,forecast_upper",
    );
    expect(csv).toHaveLength(1 + 7 + 7);
    expect(csv[1]).toBe("actual,2026-09-22,3,30000,2,2,10000,10000,10000,10000,,");
    expect(csv[8].startsWith("forecast,2026-09-29,,,,,10700,,,,")).toBe(true);
  });

  it("exports a paginated PDF report", () => {
    const pdf = analyticsToPdf(computeMarketAnalytics(db, { range: "90d", now: NOW })).toString("utf8");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("Energy Trading Analytics");
    expect(pdf).toContain("2026-09-28");
    expect(pdf).toMatch(/\/Count [2-9]/); // 90 daily rows need more than one page
    expect(pdf).not.toMatch(/[^\x00-\x7f]/); // standard fonts only cover ASCII here
  });

  it("aggregates large datasets quickly", () => {
    const big = new Database(":memory:");
    schema(big);
    const insert = big.prepare("INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, ?, ?, 'submitted')");
    const start = Date.UTC(2026, 6, 1); // first day of the 90-day window ending 2026-09-28
    big.transaction(() => {
      for (let i = 0; i < 200_000; i++) {
        const at = new Date(start + (i % 90) * 86_400_000 + (i % 1440) * 60_000).toISOString();
        insert.run(`M${i % 500}`, 500 + (i % 1000), String(5_000 + (i % 700)), at);
      }
    })();
    const t0 = performance.now();
    const r = computeMarketAnalytics(big, { range: "90d", now: NOW });
    const elapsed = performance.now() - t0;
    expect(r.summary.trades).toBe(200_000);
    expect(r.summary.activeMeters).toBe(500);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("market analytics routes", () => {
  let server: Server;
  let base: string;
  let queries = 0;
  const db = seedMarket();

  beforeAll(async () => {
    const app = express();
    app.use(
      "/api/analytics/market",
      createMarketAnalyticsRouter(() => {
        queries++;
        return db;
      }),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/analytics/market`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves analytics for each range and caches them", async () => {
    for (const range of ["7d", "30d", "90d"]) {
      const res = await fetch(`${base}?range=${range}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.range).toBe(range);
      expect(body.daily.length).toBe(Number(range.replace("d", "")));
    }
    const before = queries;
    await fetch(`${base}?range=7d`);
    expect(queries).toBe(before);
  });

  it("validates parameters", async () => {
    expect((await fetch(`${base}?range=1y`)).status).toBe(400);
    expect((await fetch(`${base}?meter_id=${"x".repeat(65)}`)).status).toBe(400);
    expect((await fetch(`${base}/export?format=xlsx`)).status).toBe(400);
  });

  it("downloads CSV and PDF exports", async () => {
    const csv = await fetch(`${base}/export?range=7d&format=csv&meter_id=A`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename=energy-trading-7d-A-\d{4}-\d{2}-\d{2}\.csv/);
    expect((await csv.text()).split("\n")[0]).toContain("avg_price_stroops_per_kwh");

    const pdf = await fetch(`${base}/export?range=30d&format=pdf`);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 8).toString()).toBe("%PDF-1.4");
  });
});
