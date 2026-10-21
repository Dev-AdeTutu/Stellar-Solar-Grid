import { beforeEach, describe, expect, it } from "vitest";
import {
  backtestAccuracy,
  forecastRegion,
  linearFit,
  recommendInvestments,
  recordObservation,
  resetCapacityPlanning,
  setCapacity,
} from "../src/lib/capacityPlanning.js";
import { StorageAgent, DEFAULT_CONFIG, seededRandom, step, type HourInput } from "../src/lib/storageOptimizer.js";
import { addStory, investorReport, resetImpact, sdgAlignment, sroi, totals, upsertRecord } from "../src/lib/impact.js";

describe("#1050 capacity planning", () => {
  beforeEach(() => {
    resetCapacityPlanning();
    for (let i = 0; i < 12; i++) {
      recordObservation({ region: "north", month: `2026-${String(i + 1).padStart(2, "0")}`, meters: 100 + 10 * i, peakKw: 200 + 20 * i });
    }
    setCapacity("north", 600);
  });

  it("fits a perfect linear trend", () => {
    const fit = linearFit([1, 3, 5, 7]);
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.intercept).toBeCloseTo(1);
    expect(fit.r2).toBeCloseTo(1);
  });

  it("predicts the bottleneck month", () => {
    // last fitted peak = 420, +20/mo; 85% of 600 = 510 → reached at month 5 (520)
    expect(forecastRegion("north", 24).bottleneckInMonths).toBe(5);
  });

  it("scenarios shift the bottleneck", () => {
    const aggressive = forecastRegion("north", 24, "aggressive").bottleneckInMonths!;
    const conservative = forecastRegion("north", 24, "conservative").bottleneckInMonths!;
    expect(aggressive).toBeLessThan(conservative);
  });

  it("generates prioritized investment recommendations", () => {
    const [rec] = recommendInvestments(12);
    expect(rec.region).toBe("north");
    expect(rec.priority).toBe("high");
    expect(rec.additionalKw).toBeGreaterThan(0);
    expect(rec.estimatedCost).toBe(rec.additionalKw * 1200);
  });

  it("backtest accuracy is near-perfect on linear data", () => {
    expect(backtestAccuracy("north").mape).toBeLessThan(0.01);
  });
});

describe("#1053 storage optimization", () => {
  const battery = { capacityKwh: 10, maxRateKw: 5, efficiency: 0.95, socKwh: 0 };
  const day: HourInput[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    pricePerKwh: hour >= 17 && hour <= 21 ? 0.4 : hour < 6 ? 0.08 : 0.15,
    solarKwh: hour >= 9 && hour <= 15 ? 2 : 0,
    loadKwh: hour >= 17 && hour <= 21 ? 3 : 1,
  }));

  it("step respects capacity and rate limits", () => {
    const { battery: b } = step({ ...battery, socKwh: 9 }, day[0], "charge");
    expect(b.socKwh).toBeLessThanOrEqual(10);
    const { result } = step({ ...battery, socKwh: 10 }, day[18], "discharge");
    expect(result.gridImportKwh).toBe(0);
  });

  it("learns a policy that beats the no-battery baseline", () => {
    const agent = new StorageAgent(DEFAULT_CONFIG, seededRandom(7));
    agent.train(day, battery, 2000);
    const plan = agent.plan(day, battery);
    expect(plan.schedule).toHaveLength(24);
    expect(plan.savings).toBeGreaterThan(0);
    expect(plan.gridIndependence).toBeGreaterThan(0);
  });
});

describe("#1054 social impact", () => {
  beforeEach(() => {
    resetImpact();
    upsertRecord({ projectId: "p1", householdsElectrified: 100, jobsCreated: 5, incomeBefore: 100, incomeAfter: 120, kwhDelivered: 100_000, investmentUsd: 50_000 });
  });

  it("totals households, jobs and income", () => {
    const t = totals();
    expect(t.householdsElectrified).toBe(100);
    expect(t.jobsCreated).toBe(5);
    expect(t.annualIncomeGainUsd).toBe(24_000);
    expect(t.avgIncomeImprovementPct).toBe(20);
    expect(t.co2AvoidedTonnes).toBe(70);
  });

  it("maps to SDGs 7, 8 and 13", () => {
    expect(sdgAlignment().map((s) => s.sdg)).toEqual([7, 8, 13]);
  });

  it("computes SROI", () => {
    // 100*180 + 5*2400 + 24000 + 70*51 = 57570
    expect(sroi().socialValueUsd).toBe(57_570);
    expect(sroi().ratio).toBeCloseTo(1.15, 2);
  });

  it("includes stories in investor reports", () => {
    addStory("p1", "Amina", "Our shop now stays open after dark.");
    const r = investorReport("p1");
    expect(r.stories).toHaveLength(1);
    expect(r.scope).toBe("p1");
  });
});
