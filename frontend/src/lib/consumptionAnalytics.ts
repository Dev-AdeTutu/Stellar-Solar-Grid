/**
 * Client for the consumption pattern analysis API (#928).
 */
import { env } from "@/lib/env";

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/analytics/patterns`;

export type AnomalySeverity = "info" | "warning" | "critical";
export type PatternKind =
  | "steady"
  | "morning_peak"
  | "evening_peak"
  | "daytime_workload"
  | "overnight"
  | "intermittent";
export type InsightCategory = "peak_shifting" | "efficiency" | "anomaly" | "trend" | "flexibility";

export type ConsumptionPattern = {
  id: string;
  kind: PatternKind;
  label: string;
  centroid: number[];
  sharePct: number;
  days: number;
  peakHour: number;
  troughHour: number;
  loadFactor: number;
  variability: number;
};

export type ConsumptionForecastPoint = {
  timestamp: string;
  predictedKwh: number;
  lowerKwh: number;
  upperKwh: number;
};

export type ConsumptionAnomaly = {
  id: string;
  meterId: string;
  timestamp: string;
  hour: number;
  weekday: number;
  energyKwh: number;
  expectedKwh: number;
  deviationPct: number;
  score: number;
  severity: AnomalySeverity;
  direction: "over" | "under";
  description: string;
  acknowledged: boolean;
  detectedAt: string;
};

export type ConsumptionInsight = {
  id: string;
  category: InsightCategory;
  title: string;
  detail: string;
  estimatedAnnualKwh: number;
  estimatedAnnualXlm: number;
  priority: number;
};

export type ConsumptionAnalysis = {
  meterId: string;
  generatedAt: string;
  windowDays: number;
  observedHours: number;
  totalKwh: number;
  averageHourlyKwh: number;
  peakHourlyKwh: number;
  peakHour: number | null;
  /** Null when history is too short for the model to be scored. */
  accuracyPct: number | null;
  sufficientData: boolean;
  patterns: ConsumptionPattern[];
  anomalySummary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
    sufficientData: boolean;
  };
  forecast: ConsumptionForecastPoint[];
  insights: ConsumptionInsight[];
};

export type TrendSeries = {
  actual: Array<{ timestamp: string; energyKwh: number }>;
  forecast: ConsumptionForecastPoint[];
};

export type WeeklyInsightsReport = {
  id: string;
  meterId: string;
  weekStart: string;
  weekEnd: string;
  totalKwh: number;
  predictedKwh: number;
  forecastAccuracyPct: number | null;
  anomalyCount: number;
  topPattern: string | null;
  insights: ConsumptionInsight[];
  generatedAt: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

export function fetchAnalysis(meterId: string, days = 90): Promise<ConsumptionAnalysis> {
  return getJson<ConsumptionAnalysis>(`${API}/${encodeURIComponent(meterId)}?days=${days}`);
}

export function fetchTrends(meterId: string, forecastHours = 168): Promise<TrendSeries> {
  return getJson<TrendSeries>(
    `${API}/${encodeURIComponent(meterId)}/trends?forecastHours=${forecastHours}`,
  );
}

export async function fetchAnomalies(meterId: string): Promise<ConsumptionAnomaly[]> {
  const body = await getJson<{ anomalies: ConsumptionAnomaly[] }>(
    `${API}/${encodeURIComponent(meterId)}/anomalies`,
  );
  return body.anomalies;
}

export async function acknowledgeAnomaly(id: string): Promise<ConsumptionAnomaly> {
  const res = await fetch(`${API}/anomalies/${encodeURIComponent(id)}/ack`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as ConsumptionAnomaly;
}

export async function fetchWeeklyReports(meterId: string): Promise<WeeklyInsightsReport[]> {
  const body = await getJson<{ reports: WeeklyInsightsReport[] }>(
    `${API}/${encodeURIComponent(meterId)}/weekly`,
  );
  return body.reports;
}

export async function generateWeeklyReport(meterId: string): Promise<WeeklyInsightsReport> {
  const res = await fetch(`${API}/${encodeURIComponent(meterId)}/weekly`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as WeeklyInsightsReport;
}

/** Mean of a pattern centroid by hour, for overlaying profiles on one axis. */
export function averageCentroid(patterns: ConsumptionPattern[]): number[] {
  if (patterns.length === 0) return Array(24).fill(0);
  return Array.from({ length: 24 }, (_, hour) =>
    patterns.reduce((sum, pattern) => sum + (pattern.centroid[hour] ?? 0), 0) / patterns.length,
  );
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function formatKwh(kwh: number): string {
  return `${kwh.toLocaleString(undefined, { maximumFractionDigits: 2 })} kWh`;
}

export function formatAccuracy(accuracyPct: number | null): string {
  return accuracyPct == null ? "Not enough history" : `${accuracyPct.toFixed(1)}%`;
}

export const SEVERITY_BADGE: Record<AnomalySeverity, string> = {
  info: "bg-blue-900/40 text-blue-300",
  warning: "bg-yellow-900/40 text-yellow-300",
  critical: "bg-red-900/40 text-red-300",
};

/**
 * Client for the appliance-level energy monitoring API (#983).
 */
const APPLIANCE_API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/meters`;

export type ApplianceCategory =
  | "refrigeration"
  | "hvac"
  | "lighting"
  | "water_heating"
  | "laundry"
  | "cooking"
  | "electronics"
  | "other";

export type ApplianceUsage = {
  id: string;
  meterId: string;
  applianceId: string;
  name: string;
  category: ApplianceCategory;
  /** Share of the meter's total consumption attributed to this appliance. */
  sharePct: number;
  energyKwh: number;
  estimatedAnnualKwh: number;
  estimatedAnnualXlm: number;
  /** Mean power draw while the appliance is active, in watts. */
  averageWatts: number;
  /** Fraction of the window during which the appliance was detected as active. */
  dutyCycle: number;
  /** Detection confidence in the range 0..1. */
  confidence: number;
  /** How the appliance was identified. */
  detectionMethod: "sub_meter" | "ml_disaggregation";
  trend: "rising" | "falling" | "steady";
  /** Percentage change versus the previous comparable window. */
  trendPct: number;
  lastSeenAt: string;
};

export type ApplianceRecommendation = {
  id: string;
  applianceId: string;
  title: string;
  detail: string;
  estimatedAnnualKwh: number;
  estimatedAnnualXlm: number;
  priority: number;
};

export type ApplianceBreakdown = {
  meterId: string;
  generatedAt: string;
  windowDays: number;
  totalKwh: number;
  sufficientData: boolean;
  appliances: ApplianceUsage[];
  recommendations: ApplianceRecommendation[];
};

export function fetchApplianceBreakdown(
  meterId: string,
  days = 30,
): Promise<ApplianceBreakdown> {
  return getJson<ApplianceBreakdown>(
    `${APPLIANCE_API}/${encodeURIComponent(meterId)}/appliances?days=${days}`,
  );
}

export function formatWatts(watts: number): string {
  if (watts >= 1000) {
    return `${(watts / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kW`;
  }
  return `${Math.round(watts).toLocaleString()} W`;
}

export function formatShare(sharePct: number): string {
  return `${sharePct.toFixed(1)}%`;
}

export function formatDutyCycle(dutyCycle: number): string {
  return `${(dutyCycle * 100).toFixed(0)}% of the time`;
}

export function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}% confidence`;
}

export const APPLIANCE_CATEGORY_LABEL: Record<ApplianceCategory, string> = {
  refrigeration: "Refrigeration",
  hvac: "Heating & cooling",
  lighting: "Lighting",
  water_heating: "Water heating",
  laundry: "Laundry",
  cooking: "Cooking",
  electronics: "Electronics",
  other: "Other",
};

export const APPLIANCE_TREND_BADGE: Record<ApplianceUsage["trend"], string> = {
  rising: "bg-red-900/40 text-red-300",
  falling: "bg-green-900/40 text-green-300",
  steady: "bg-slate-700/40 text-slate-300",
};
