import { describe, it, expect } from "vitest";
import {
  classifyCapacityTier,
  classifyLocationType,
  calculatePerformanceScore,
  calculatePercentileRank,
  benchmarkMeter,
} from "../src/lib/benchmarking.js";

describe("Meter Performance Benchmarking (#974)", () => {
  it("correctly classifies meters into capacity tiers", () => {
    expect(classifyCapacityTier(4000)).toBe("residential");
    expect(classifyCapacityTier(9999)).toBe("residential");
    expect(classifyCapacityTier(15000)).toBe("commercial");
    expect(classifyCapacityTier(60000)).toBe("industrial");
  });

  it("correctly classifies location types", () => {
    expect(classifyLocationType("Downtown Metropolis")).toBe("urban");
    expect(classifyLocationType("Pine Ridge Suburb")).toBe("suburban");
    expect(classifyLocationType("Sunny Valley Farm")).toBe("rural");
    expect(classifyLocationType(null)).toBe("urban");
  });

  it("calculates performance score (0-100) and percentile rankings", () => {
    const scoreHigh = calculatePerformanceScore(95, 99.5, 1.2);
    expect(scoreHigh).toBeGreaterThan(85);
    expect(scoreHigh).toBeLessThanOrEqual(100);

    const percentile = calculatePercentileRank(scoreHigh);
    expect(percentile).toBeGreaterThan(70);
    expect(percentile).toBeLessThanOrEqual(100);

    const scoreLow = calculatePerformanceScore(50, 70, 0.4);
    expect(scoreLow).toBeLessThan(60);
  });

  it("generates full benchmark comparison report for a meter", () => {
    const report = benchmarkMeter("METER-BENCH-001");
    expect(report.meterId).toBe("METER-BENCH-001");
    expect(report.peerGroup).toBeDefined();
    expect(report.capacityTier).toBeDefined();
    expect(report.locationType).toBeDefined();
    expect(report.performanceScore).toBeGreaterThanOrEqual(0);
    expect(report.performanceScore).toBeLessThanOrEqual(100);
    expect(report.percentileRank).toBeGreaterThanOrEqual(0);
    expect(report.percentileRank).toBeLessThanOrEqual(100);
    expect(report.meterStats).toBeDefined();
    expect(report.peerGroupAverages).toBeDefined();
    expect(report.comparison).toBeDefined();
  });
});
