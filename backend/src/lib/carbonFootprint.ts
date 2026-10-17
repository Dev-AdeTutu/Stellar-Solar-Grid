import { db as usageDb } from "./usageEvents.js";

export const REGIONAL_GRID_FACTORS: Record<string, number> = {
  US: 0.385,
  EU: 0.250,
  CA: 0.210,
  Coal: 0.850,
  Default: 0.500,
};

export const KG_CO2_PER_TREE_YEAR = 21.77;
export const KG_CO2_PER_CAR_MILE = 0.404;

export type CarbonMetrics = {
  kwh: number;
  kgCo2Saved: number;
  treesEquivalent: number;
  carMilesOffset: number;
};

export type CarbonFootprintResponse = {
  meterId: string;
  region: string;
  gridFactorKgPerKwh: number;
  lifetime: CarbonMetrics;
  monthly: CarbonMetrics;
  yearly: CarbonMetrics;
  badge: {
    tier: "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond";
    label: string;
    description: string;
    svgBadge: string;
  };
};

export function getGridFactor(region = "Default"): number {
  const norm = region.trim().toUpperCase();
  if (norm === "US" || norm === "USA") return REGIONAL_GRID_FACTORS.US;
  if (norm === "EU" || norm === "EUROPE") return REGIONAL_GRID_FACTORS.EU;
  if (norm === "CA" || norm === "CANADA" || norm === "CALIFORNIA") return REGIONAL_GRID_FACTORS.CA;
  if (norm === "COAL") return REGIONAL_GRID_FACTORS.Coal;
  return REGIONAL_GRID_FACTORS.Default;
}

export function calculateCarbonMetrics(kwh: number, factor: number): CarbonMetrics {
  const safeKwh = Math.max(0, kwh);
  const kgCo2Saved = Number((safeKwh * factor).toFixed(2));
  const treesEquivalent = Number((kgCo2Saved / KG_CO2_PER_TREE_YEAR).toFixed(2));
  const carMilesOffset = Number((kgCo2Saved / KG_CO2_PER_CAR_MILE).toFixed(2));

  return {
    kwh: safeKwh,
    kgCo2Saved,
    treesEquivalent,
    carMilesOffset,
  };
}

export function getBadge(kgCo2Saved: number): {
  tier: "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond";
  label: string;
  description: string;
  svgBadge: string;
} {
  let tier: "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond" = "Bronze";
  let color = "#cd7f32";
  if (kgCo2Saved >= 10000) {
    tier = "Diamond";
    color = "#b9f2ff";
  } else if (kgCo2Saved >= 5000) {
    tier = "Platinum";
    color = "#e5e4e2";
  } else if (kgCo2Saved >= 1000) {
    tier = "Gold";
    color = "#ffd700";
  } else if (kgCo2Saved >= 250) {
    tier = "Silver";
    color = "#c0c0c0";
  }

  const label = `${tier} Solar Saver`;
  const description = `${kgCo2Saved.toFixed(1)} kg CO2 emissions offset with solar energy`;

  const svgBadge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 80" width="280" height="80">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1e293b;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0f172a;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="280" height="80" rx="12" fill="url(#grad)" stroke="${color}" stroke-width="2"/>
  <circle cx="40" cy="40" r="22" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2"/>
  <text x="40" y="46" font-size="20" text-anchor="middle">☀️</text>
  <text x="75" y="34" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#ffffff">${label}</text>
  <text x="75" y="54" font-family="system-ui, sans-serif" font-size="11" fill="#94a3b8">${kgCo2Saved.toFixed(1)} kg CO2 Offset</text>
</svg>`;

  return { tier, label, description, svgBadge };
}

export function getMeterCarbonFootprint(meterId: string, region = "Default"): CarbonFootprintResponse {
  const factor = getGridFactor(region);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);

  const udb = usageDb();

  // Query lifetime kwh
  const lifetimeDetail = udb
    .prepare("SELECT COALESCE(SUM(units), 0) AS units FROM usage_events WHERE meter_id = ?")
    .get(meterId) as { units: number };
  const lifetimeSummary = udb
    .prepare("SELECT COALESCE(SUM(total_units), 0) AS units FROM usage_summary WHERE meter_id = ?")
    .get(meterId) as { units: number };
  const lifetimeKwh = (lifetimeDetail?.units ?? 0) + (lifetimeSummary?.units ?? 0);

  // Query monthly kwh (last 30 days)
  const monthlyDetail = udb
    .prepare("SELECT COALESCE(SUM(units), 0) AS units FROM usage_events WHERE meter_id = ? AND received_at >= ?")
    .get(meterId, thirtyDaysAgo.toISOString()) as { units: number };
  const monthlySummary = udb
    .prepare("SELECT COALESCE(SUM(total_units), 0) AS units FROM usage_summary WHERE meter_id = ? AND date >= ?")
    .get(meterId, thirtyDaysAgo.toISOString().slice(0, 10)) as { units: number };
  const monthlyKwh = (monthlyDetail?.units ?? 0) + (monthlySummary?.units ?? 0);

  // Query yearly kwh (last 365 days)
  const yearlyDetail = udb
    .prepare("SELECT COALESCE(SUM(units), 0) AS units FROM usage_events WHERE meter_id = ? AND received_at >= ?")
    .get(meterId, oneYearAgo.toISOString()) as { units: number };
  const yearlySummary = udb
    .prepare("SELECT COALESCE(SUM(total_units), 0) AS units FROM usage_summary WHERE meter_id = ? AND date >= ?")
    .get(meterId, oneYearAgo.toISOString().slice(0, 10)) as { units: number };
  const yearlyKwh = (yearlyDetail?.units ?? 0) + (yearlySummary?.units ?? 0);

  const lifetime = calculateCarbonMetrics(lifetimeKwh, factor);
  const monthly = calculateCarbonMetrics(monthlyKwh, factor);
  const yearly = calculateCarbonMetrics(yearlyKwh, factor);
  const badge = getBadge(lifetime.kgCo2Saved);

  return {
    meterId,
    region,
    gridFactorKgPerKwh: factor,
    lifetime,
    monthly,
    yearly,
    badge,
  };
}
