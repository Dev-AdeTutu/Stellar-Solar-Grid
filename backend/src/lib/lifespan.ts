/**
 * Meter lifespan extension recommendations (#1079).
 *
 * Analyses recorded failure events per meter, derives a preventive maintenance
 * schedule, computes ROI of maintenance vs replacement, ranks actions by
 * impact, and tracks lifespan extension achieved. See backend/LIFESPAN.md.
 */

export type FailureCause = "overheating" | "moisture" | "power_surge" | "relay_wear" | "firmware" | "connectivity" | "other";

export interface FailureEvent {
  meterId: string;
  cause: FailureCause;
  occurredAt: string;
  downtimeHours: number;
  repairCost: number;
}

export interface MaintenanceAction {
  id: string;
  cause: FailureCause;
  title: string;
  intervalDays: number;
  cost: number;
  /** Fraction of failures of this cause prevented (0..1). */
  effectiveness: number;
  /** Months of service life gained when performed on schedule. */
  lifeGainMonths: number;
}

export interface Recommendation extends MaintenanceAction {
  failureCount: number;
  expectedAnnualSavings: number;
  annualCost: number;
  roi: number;
  impactScore: number;
  nextDueAt: string;
}

export const DEFAULT_DESIGN_LIFE_MONTHS = 120;
export const REPLACEMENT_COST = Number(process.env.METER_REPLACEMENT_COST ?? 250);

export const ACTION_CATALOG: MaintenanceAction[] = [
  { id: "clean-vents", cause: "overheating", title: "Clean vents and check enclosure airflow", intervalDays: 90, cost: 10, effectiveness: 0.6, lifeGainMonths: 12 },
  { id: "reseal-enclosure", cause: "moisture", title: "Reseal enclosure gaskets and cable glands", intervalDays: 180, cost: 25, effectiveness: 0.7, lifeGainMonths: 18 },
  { id: "surge-protector", cause: "power_surge", title: "Inspect / replace surge protection device", intervalDays: 365, cost: 40, effectiveness: 0.8, lifeGainMonths: 24 },
  { id: "relay-service", cause: "relay_wear", title: "Service relay contacts, reduce switching cycles", intervalDays: 180, cost: 30, effectiveness: 0.5, lifeGainMonths: 15 },
  { id: "firmware-update", cause: "firmware", title: "Apply latest stable firmware", intervalDays: 90, cost: 2, effectiveness: 0.9, lifeGainMonths: 6 },
  { id: "antenna-check", cause: "connectivity", title: "Check antenna, SIM and signal strength", intervalDays: 180, cost: 8, effectiveness: 0.6, lifeGainMonths: 4 },
  { id: "general-inspection", cause: "other", title: "General visual inspection", intervalDays: 365, cost: 15, effectiveness: 0.3, lifeGainMonths: 6 },
];

const failures = new Map<string, FailureEvent[]>();
const installedAt = new Map<string, string>();
const completed = new Map<string, { actionId: string; completedAt: string }[]>();

export function recordFailure(event: FailureEvent): FailureEvent {
  const list = failures.get(event.meterId) ?? [];
  list.push(event);
  failures.set(event.meterId, list);
  return event;
}

export function setInstallDate(meterId: string, iso: string): void {
  installedAt.set(meterId, iso);
}

export function recordMaintenance(meterId: string, actionId: string, completedAt = new Date().toISOString()) {
  if (!ACTION_CATALOG.some((a) => a.id === actionId)) throw new Error(`Unknown action: ${actionId}`);
  const list = completed.get(meterId) ?? [];
  const entry = { actionId, completedAt };
  list.push(entry);
  completed.set(meterId, list);
  return entry;
}

/** Failure counts, downtime and cost grouped by cause, most frequent first. */
export function analyzeFailures(meterId: string) {
  const byCause = new Map<FailureCause, { count: number; downtimeHours: number; repairCost: number }>();
  for (const f of failures.get(meterId) ?? []) {
    const agg = byCause.get(f.cause) ?? { count: 0, downtimeHours: 0, repairCost: 0 };
    agg.count += 1;
    agg.downtimeHours += f.downtimeHours;
    agg.repairCost += f.repairCost;
    byCause.set(f.cause, agg);
  }
  return [...byCause.entries()]
    .map(([cause, agg]) => ({ cause, ...agg }))
    .sort((a, b) => b.count - a.count);
}

function observedYears(meterId: string, now: Date): number {
  const list = failures.get(meterId) ?? [];
  const start = installedAt.get(meterId) ?? list.map((f) => f.occurredAt).sort()[0];
  if (!start) return 1;
  return Math.max((now.getTime() - new Date(start).getTime()) / (365 * 86_400_000), 1 / 12);
}

/** Recommendations ranked by impact (savings + life gained). */
export function recommend(meterId: string, now = new Date()): Recommendation[] {
  const years = observedYears(meterId, now);
  const analysis = new Map(analyzeFailures(meterId).map((a) => [a.cause, a]));
  const done = completed.get(meterId) ?? [];
  return ACTION_CATALOG.map((action) => {
    const a = analysis.get(action.cause);
    const failureCount = a?.count ?? 0;
    const annualFailureCost = a ? a.repairCost / years : 0;
    const expectedAnnualSavings = annualFailureCost * action.effectiveness;
    const annualCost = action.cost * (365 / action.intervalDays);
    const roi = annualCost > 0 ? (expectedAnnualSavings - annualCost) / annualCost : 0;
    const lastDone = done.filter((d) => d.actionId === action.id).map((d) => d.completedAt).sort().pop();
    const next = new Date(lastDone ? new Date(lastDone).getTime() + action.intervalDays * 86_400_000 : now.getTime());
    const lifeValue = (action.lifeGainMonths / DEFAULT_DESIGN_LIFE_MONTHS) * REPLACEMENT_COST;
    const impactScore = Math.round((expectedAnnualSavings + lifeValue) * (failureCount > 0 ? 1 : 0.25) * 100) / 100;
    return {
      ...action,
      failureCount,
      expectedAnnualSavings: round(expectedAnnualSavings),
      annualCost: round(annualCost),
      roi: round(roi),
      impactScore,
      nextDueAt: next.toISOString(),
    };
  }).sort((x, y) => y.impactScore - x.impactScore);
}

/** Compare cost of keeping the meter on a maintenance plan vs replacing it now. */
export function maintenanceVsReplacement(meterId: string, now = new Date()) {
  const recs = recommend(meterId, now).filter((r) => r.failureCount > 0 || r.roi > 0);
  const years = observedYears(meterId, now);
  const annualRepairCost = analyzeFailures(meterId).reduce((s, a) => s + a.repairCost, 0) / years;
  const maintenanceAnnualCost = recs.reduce((s, r) => s + r.annualCost, 0);
  const savings = recs.reduce((s, r) => s + r.expectedAnnualSavings, 0);
  const maintainAnnual = maintenanceAnnualCost + annualRepairCost - savings;
  const remaining = lifespanStatus(meterId, now).remainingMonths / 12;
  const replaceAnnual = REPLACEMENT_COST / Math.max(DEFAULT_DESIGN_LIFE_MONTHS / 12, 1);
  return {
    maintainAnnualCost: round(maintainAnnual),
    replaceAnnualizedCost: round(replaceAnnual),
    remainingYears: round(remaining),
    recommendation: maintainAnnual <= replaceAnnual || remaining > 1 ? "maintain" : "replace",
    maintenanceRoi: maintenanceAnnualCost > 0 ? round((savings - maintenanceAnnualCost) / maintenanceAnnualCost) : 0,
  };
}

/** Lifespan extension achieved through completed maintenance. */
export function lifespanStatus(meterId: string, now = new Date()) {
  const extensionMonths = (completed.get(meterId) ?? []).reduce((s, d) => {
    const action = ACTION_CATALOG.find((a) => a.id === d.actionId)!;
    // Each completion contributes the gain spread across its interval cadence.
    return s + action.lifeGainMonths * (action.intervalDays / (DEFAULT_DESIGN_LIFE_MONTHS * 30));
  }, 0);
  const start = installedAt.get(meterId);
  const ageMonths = start ? (now.getTime() - new Date(start).getTime()) / (30 * 86_400_000) : 0;
  const failurePenalty = (failures.get(meterId) ?? []).length * 2;
  const expected = DEFAULT_DESIGN_LIFE_MONTHS + extensionMonths - failurePenalty;
  return {
    designLifeMonths: DEFAULT_DESIGN_LIFE_MONTHS,
    extensionMonths: round(extensionMonths),
    expectedLifeMonths: round(expected),
    ageMonths: round(ageMonths),
    remainingMonths: round(Math.max(expected - ageMonths, 0)),
    completedActions: (completed.get(meterId) ?? []).length,
  };
}

export function _resetLifespan(): void {
  failures.clear();
  installedAt.clear();
  completed.clear();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
