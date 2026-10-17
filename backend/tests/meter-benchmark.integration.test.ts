import { describe, it, expect } from "vitest";

process.env.ADMIN_SECRET_KEY = "SCKUYV5P4VUHLFNUNCLQV3EPPTGDD4CCUDOFEXEBFIJAO4YMHIN2YDOE";
process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.METER_BENCHMARK_DB_PATH = ":memory:";
process.env.USAGE_EVENTS_DB_PATH = ":memory:";

const {
  getCapacityTier,
  parseLocationType,
  computeMeterPerformanceScore,
  upsertMeterProfile,
  getBenchmarkComparison,
} = await import("../src/lib/meterBenchmark.js");

describe("Meter Performance Benchmarking (#974)", () => {
  it("categorizes capacity tiers correctly", () => {
    expect(getCapacityTier(3000)).toBe("residential_small");
    expect(getCapacityTier(4999)).toBe("residential_small");
    expect(getCapacityTier(5000)).toBe("residential_large");
    expect(getCapacityTier(15000)).toBe("residential_large");
    expect(getCapacityTier(15001)).toBe("commercial");
    expect(getCapacityTier(50000)).toBe("commercial");
  });

  it("parses location types reliably", () => {
    expect(parseLocationType("Downtown Urban")).toBe("urban");
    expect(parseLocationType("Rural Farm")).toBe("rural");
    expect(parseLocationType("Suburban District")).toBe("suburban");
    expect(parseLocationType(undefined)).toBe("suburban");
  });

  it("computes bounded composite performance score (0-100)", () => {
    const score = computeMeterPerformanceScore(0.85, 99.0, 0.9);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBe(92);
  });

  it("generates benchmark comparison with peer group averages and percentile rank", () => {
    const meterId = "MTR_BENCHMARK_1";
    upsertMeterProfile(meterId, 4000, "suburban");

    const result = getBenchmarkComparison(meterId);
    expect(result.meterId).toBe(meterId);
    expect(result.meter.capacityTier).toBe("residential_small");
    expect(result.meter.locationType).toBe("suburban");
    expect(result.peerGroup.capacityTier).toBe("residential_small");
    expect(result.peerGroup.locationType).toBe("suburban");
    expect(result.peerGroup.meterCount).toBeGreaterThan(0);
    expect(result.percentileRank).toBeGreaterThanOrEqual(1);
    expect(result.percentileRank).toBeLessThanOrEqual(99);
    expect(result.insights.length).toBeGreaterThan(0);
  });
});
