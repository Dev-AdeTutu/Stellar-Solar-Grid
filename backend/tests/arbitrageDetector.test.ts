import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { detectMeterArbitrage } from "../src/lib/arbitrageDetector.js";
import { insightsRouter } from "../src/routes/insights.js";

describe("Energy Arbitrage Opportunities Detector (#1009)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/meters", insightsRouter);

  it("monitors grid prices and solar generation and calculates optimal charge/discharge schedule", () => {
    const report = detectMeterArbitrage("METER-ARB-1", {
      batteryCapacityKwh: 15,
      roundTripEfficiency: 0.9,
    });

    expect(report.meterId).toBe("METER-ARB-1");
    expect(report.optimalSchedule).toHaveLength(24);
    expect(report.opportunities.length).toBeGreaterThanOrEqual(2);
    expect(report.estimatedDailyProfitUsd).toBeGreaterThan(0);
    expect(report.estimatedMonthlyProfitUsd).toBeCloseTo(report.estimatedDailyProfitUsd * 30, 1);
    expect(report.alerts.length).toBeGreaterThan(0);

    const actions = new Set(report.optimalSchedule.map((s) => s.action));
    expect(actions.has("charge")).toBe(true);
    expect(actions.has("discharge")).toBe(true);
  });

  it("GET /api/meters/:meterId/arbitrage returns opportunities and profit estimates", async () => {
    const res = await request(app).get("/api/meters/METER-ARB-2/arbitrage?batteryCapacityKwh=20");
    expect(res.status).toBe(200);
    expect(res.body.meterId).toBe("METER-ARB-2");
    expect(res.body.batteryCapacityKwh).toBe(20);
    expect(Array.isArray(res.body.opportunities)).toBe(true);
    expect(res.body.opportunities.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.optimalSchedule)).toBe(true);
    expect(Array.isArray(res.body.alerts)).toBe(true);
  });
});
