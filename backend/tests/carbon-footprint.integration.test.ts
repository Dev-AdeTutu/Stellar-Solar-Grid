import { describe, it, expect } from "vitest";
import {
  calculateCarbonSavings,
  getCarbonBadge,
  getMeterCarbonFootprint,
  REGIONAL_CARBON_FACTORS,
} from "../src/lib/carbonFootprint.js";

describe("Carbon Footprint Calculator (#972)", () => {
  it("calculates CO2 savings, tree equivalent, and car miles offset accurately", () => {
    const kwh = 1000;
    const factor = REGIONAL_CARBON_FACTORS.US; // 0.385
    const result = calculateCarbonSavings(kwh, factor);

    expect(result.kgCo2Saved).toBe(385);
    // 385 / 21 = 18.33 trees
    expect(result.treesEquivalent).toBeCloseTo(18.33, 1);
    // 385 / 0.404 = 952.97 miles
    expect(result.carMilesOffset).toBeCloseTo(952.97, 1);
  });

  it("assigns appropriate badges based on carbon savings threshold", () => {
    const bronze = getCarbonBadge(100, "METER-1");
    expect(bronze.tier).toBe("bronze");

    const silver = getCarbonBadge(300, "METER-1");
    expect(silver.tier).toBe("silver");

    const gold = getCarbonBadge(1500, "METER-1");
    expect(gold.tier).toBe("gold");

    const platinum = getCarbonBadge(6000, "METER-1");
    expect(platinum.tier).toBe("platinum");
    expect(platinum.share_url).toContain("tier=platinum");
  });

  it("returns full carbon footprint report for a meter", () => {
    const report = getMeterCarbonFootprint("METER-TEST-002", "EU");
    expect(report.meter_id).toBe("METER-TEST-002");
    expect(report.carbon_intensity_factor).toBe(REGIONAL_CARBON_FACTORS.EU);
    expect(typeof report.solar_kwh_total).toBe("number");
    expect(typeof report.kg_co2_saved).toBe("number");
    expect(Array.isArray(report.monthly_totals)).toBe(true);
    expect(Array.isArray(report.yearly_totals)).toBe(true);
    expect(report.badge).toBeDefined();
  });
});
