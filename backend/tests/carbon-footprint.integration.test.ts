import { describe, it, expect } from "vitest";

process.env.ADMIN_SECRET_KEY = "SCKUYV5P4VUHLFNUNCLQV3EPPTGDD4CCUDOFEXEBFIJAO4YMHIN2YDOE";
process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.USAGE_EVENTS_DB_PATH = ":memory:";

const {
  calculateCarbonMetrics,
  getGridFactor,
  getBadge,
  getMeterCarbonFootprint,
} = await import("../src/lib/carbonFootprint.js");

describe("Carbon Footprint Calculator (#972)", () => {
  it("resolves regional grid carbon intensity factors correctly", () => {
    expect(getGridFactor("US")).toBe(0.385);
    expect(getGridFactor("usa")).toBe(0.385);
    expect(getGridFactor("EU")).toBe(0.250);
    expect(getGridFactor("CA")).toBe(0.210);
    expect(getGridFactor("Coal")).toBe(0.850);
    expect(getGridFactor("Unknown")).toBe(0.500);
  });

  it("calculates CO2 savings, tree equivalents, and car miles offset accurately", () => {
    const kwh = 1000;
    const factor = 0.500;
    const metrics = calculateCarbonMetrics(kwh, factor);

    expect(metrics.kwh).toBe(1000);
    expect(metrics.kgCo2Saved).toBe(500.0);
    expect(metrics.treesEquivalent).toBeCloseTo(22.97, 1);
    expect(metrics.carMilesOffset).toBeCloseTo(1237.62, 1);
  });

  it("generates badges based on cumulative savings milestones", () => {
    expect(getBadge(100).tier).toBe("Bronze");
    expect(getBadge(300).tier).toBe("Silver");
    expect(getBadge(1500).tier).toBe("Gold");
    expect(getBadge(6000).tier).toBe("Platinum");
    expect(getBadge(12000).tier).toBe("Diamond");

    const badge = getBadge(1500);
    expect(badge.svgBadge).toContain("<svg");
    expect(badge.label).toBe("Gold Solar Saver");
  });

  it("returns full carbon footprint for a meter", () => {
    const footprint = getMeterCarbonFootprint("MTR_CARBON_TEST", "US");
    expect(footprint.meterId).toBe("MTR_CARBON_TEST");
    expect(footprint.gridFactorKgPerKwh).toBe(0.385);
    expect(footprint.lifetime).toBeDefined();
    expect(footprint.monthly).toBeDefined();
    expect(footprint.yearly).toBeDefined();
    expect(footprint.badge).toBeDefined();
    expect(footprint.badge.svgBadge).toContain("<svg");
  });
});
