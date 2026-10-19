import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/usageEvents", () => ({ db: vi.fn() }));

import { fitLinearRegression, predictDaysRemaining } from "../src/lib/usagePrediction";

describe("usage prediction model (#835)", () => {
  it("fits an exact linear trend", () => {
    const m = fitLinearRegression([10, 12, 14, 16, 18]);
    expect(m.slope).toBeCloseTo(2);
    expect(m.intercept).toBeCloseTo(10);
    expect(m.stdError).toBeCloseTo(0);
  });

  it("predicts days remaining for constant usage", () => {
    const usage = Array(30).fill(100);
    const p = predictDaysRemaining("M1", 1_000, usage);
    expect(p.estimatedDaysRemaining).toBeCloseTo(10, 1);
    expect(p.confidenceInterval.low).toBeCloseTo(10, 1);
    expect(p.confidenceInterval.high).toBeCloseTo(10, 1);
    expect(p.trainingDays).toBe(30);
  });

  it("produces a confidence interval that brackets the estimate for noisy usage", () => {
    const usage = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 20 : -20));
    const p = predictDaysRemaining("M2", 3_000, usage);
    expect(p.estimatedDaysRemaining).toBeGreaterThan(25);
    expect(p.estimatedDaysRemaining).toBeLessThan(35);
    expect(p.confidenceInterval.low!).toBeLessThan(p.estimatedDaysRemaining!);
    expect(p.confidenceInterval.high!).toBeGreaterThan(p.estimatedDaysRemaining!);
    expect(p.confidenceInterval.level).toBe(0.95);
  });

  it("returns null when there is no history or usage never depletes", () => {
    expect(predictDaysRemaining("M3", 1_000, []).estimatedDaysRemaining).toBeNull();
    expect(predictDaysRemaining("M4", 1_000, Array(30).fill(0)).estimatedDaysRemaining).toBeNull();
    expect(predictDaysRemaining("M5", 0, Array(30).fill(10)).estimatedDaysRemaining).toBe(0);
  });
});
