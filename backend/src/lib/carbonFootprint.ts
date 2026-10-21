import { getUsageSummary } from "./usageEvents.js";

/** Regional grid carbon intensity factors (kg CO2 per kWh). */
export const REGIONAL_CARBON_FACTORS: Record<string, number> = {
  US: 0.385,
  EU: 0.25,
  GLOBAL: 0.475,
  COAL_HEAVY: 0.82,
  HYDRO_HEAVY: 0.05,
};

export const DEFAULT_CARBON_FACTOR = REGIONAL_CARBON_FACTORS.US;
export const KG_CO2_PER_TREE_YEAR = 21.0;
export const KG_CO2_PER_CAR_MILE = 0.404;

export type CarbonBadgeTier = "bronze" | "silver" | "gold" | "platinum";

export type CarbonBadge = {
  tier: CarbonBadgeTier;
  label: string;
  share_url: string;
};

export type MonthlyCarbonTotal = {
  period: string; // YYYY-MM
  kwh: number;
  kg_co2_saved: number;
};

export type YearlyCarbonTotal = {
  year: number;
  kwh: number;
  kg_co2_saved: number;
};

export type CarbonFootprintReport = {
  meter_id: string;
  solar_kwh_total: number;
  kg_co2_saved: number;
  trees_equivalent: number;
  car_miles_offset: number;
  carbon_intensity_factor: number;
  monthly_totals: MonthlyCarbonTotal[];
  yearly_totals: YearlyCarbonTotal[];
  badge: CarbonBadge;
};

export function getCarbonBadge(kgCo2Saved: number, meterId: string): CarbonBadge {
  let tier: CarbonBadgeTier = "bronze";
  let label = "Green Explorer";

  if (kgCo2Saved >= 5000) {
    tier = "platinum";
    label = "Solar Pioneer";
  } else if (kgCo2Saved >= 1000) {
    tier = "gold";
    label = "Carbon Neutralizer";
  } else if (kgCo2Saved >= 250) {
    tier = "silver";
    label = "Clean Energy Champion";
  }

  const shareUrl = `https://solargrid.stellar.org/badges/${encodeURIComponent(meterId)}/carbon?tier=${tier}&savings=${Math.round(kgCo2Saved)}`;

  return { tier, label, share_url: shareUrl };
}

export function calculateCarbonSavings(
  kwh: number,
  intensityFactor = DEFAULT_CARBON_FACTOR,
): { kgCo2Saved: number; treesEquivalent: number; carMilesOffset: number } {
  const safeKwh = Math.max(0, kwh);
  const kgCo2Saved = Number((safeKwh * intensityFactor).toFixed(2));
  const treesEquivalent = Number((kgCo2Saved / KG_CO2_PER_TREE_YEAR).toFixed(2));
  const carMilesOffset = Number((kgCo2Saved / KG_CO2_PER_CAR_MILE).toFixed(2));

  return { kgCo2Saved, treesEquivalent, carMilesOffset };
}

export function getMeterCarbonFootprint(
  meterId: string,
  region = "US",
): CarbonFootprintReport {
  const intensity = REGIONAL_CARBON_FACTORS[region.toUpperCase()] ?? DEFAULT_CARBON_FACTOR;
  const summaries = getUsageSummary(meterId, 365);

  const monthlyMap = new Map<string, number>();
  const yearlyMap = new Map<number, number>();
  let totalKwh = 0;

  for (const row of summaries) {
    const kwh = Number(row.total_units || 0);
    totalKwh += kwh;

    const period = row.date.slice(0, 7); // YYYY-MM
    monthlyMap.set(period, (monthlyMap.get(period) ?? 0) + kwh);

    const year = parseInt(row.date.slice(0, 4), 10);
    if (!isNaN(year)) {
      yearlyMap.set(year, (yearlyMap.get(year) ?? 0) + kwh);
    }
  }

  const { kgCo2Saved, treesEquivalent, carMilesOffset } = calculateCarbonSavings(totalKwh, intensity);

  const monthlyTotals: MonthlyCarbonTotal[] = Array.from(monthlyMap.entries())
    .map(([period, kwh]) => ({
      period,
      kwh,
      kg_co2_saved: Number((kwh * intensity).toFixed(2)),
    }))
    .sort((a, b) => b.period.localeCompare(a.period));

  const yearlyTotals: YearlyCarbonTotal[] = Array.from(yearlyMap.entries())
    .map(([year, kwh]) => ({
      year,
      kwh,
      kg_co2_saved: Number((kwh * intensity).toFixed(2)),
    }))
    .sort((a, b) => b.year - a.year);

  const badge = getCarbonBadge(kgCo2Saved, meterId);

  return {
    meter_id: meterId,
    solar_kwh_total: totalKwh,
    kg_co2_saved: kgCo2Saved,
    trees_equivalent: treesEquivalent,
    car_miles_offset: carMilesOffset,
    carbon_intensity_factor: intensity,
    monthly_totals: monthlyTotals,
    yearly_totals: yearlyTotals,
    badge,
  };
}
