import { describe, expect, it } from "vitest";
import { scoreUsageAnomaly } from "../src/lib/theftScoring.js";

describe("theft anomaly scoring", () => {
  it("keeps false positives below five percent on stable meter readings", () => {
    const baseline = Array.from({ length: 40 }, (_, index) => 8 + (index % 4) * 0.2);
    const normalReadings = Array.from({ length: 100 }, (_, index) => 8 + (index % 4) * 0.2);
    const falsePositives = normalReadings.filter((reading) => scoreUsageAnomaly(reading, baseline).anomalous).length;

    expect(falsePositives / normalReadings.length).toBeLessThan(0.05);
  });

  it("flags a severe increase above the robust baseline", () => {
    const baseline = Array.from({ length: 40 }, () => 8);
    const result = scoreUsageAnomaly(100, baseline);

    expect(result.baseline).toBe(8);
    expect(result.anomalous).toBe(true);
    expect(result.score).toBeGreaterThan(10);
  });

  it("waits for enough baseline samples and ignores invalid readings", () => {
    expect(scoreUsageAnomaly(500, Array(11).fill(1)).anomalous).toBe(false);
    expect(scoreUsageAnomaly(Number.NaN, Array(40).fill(1)).anomalous).toBe(false);
    expect(scoreUsageAnomaly(500, [...Array(11).fill(1), Number.NaN]).anomalous).toBe(false);
  });
});