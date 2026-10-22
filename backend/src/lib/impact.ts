/**
 * Social impact measurement (#1054). See docs/IMPACT.md.
 *
 * Tracks households electrified, jobs created and income improvement per
 * project, maps outcomes to UN SDGs 7, 8 and 13, computes social return on
 * investment (SROI) and assembles investor impact reports.
 */

export interface ImpactRecord {
  projectId: string;
  householdsElectrified: number;
  jobsCreated: number;
  /** Average monthly household income before/after, in USD. */
  incomeBefore: number;
  incomeAfter: number;
  kwhDelivered: number;
  investmentUsd: number;
}

export interface Story {
  id: string;
  projectId: string;
  author: string;
  quote: string;
  createdAt: string;
}

/** Financial proxies used to monetise outcomes for SROI. */
export const PROXIES = {
  /** Annual value of household electrification (kerosene/health/education savings). */
  perHouseholdYear: 180,
  /** Annual value of a local job created. */
  perJobYear: 2_400,
  /** Social cost of carbon, USD per tonne. */
  perTonneCo2: 51,
  /** Grid emission factor displaced, tonnes CO2 per kWh. */
  co2PerKwh: 0.0007,
};

const records = new Map<string, ImpactRecord>();
const stories: Story[] = [];

export function upsertRecord(r: ImpactRecord): ImpactRecord {
  records.set(r.projectId, r);
  return r;
}

export function addStory(projectId: string, author: string, quote: string): Story {
  const story = { id: `story-${stories.length + 1}`, projectId, author, quote, createdAt: new Date().toISOString() };
  stories.push(story);
  return story;
}

export function listStories(projectId?: string): Story[] {
  return projectId ? stories.filter((s) => s.projectId === projectId) : [...stories];
}

export function resetImpact(): void {
  records.clear();
  stories.length = 0;
}

export function totals(projectId?: string) {
  const list = projectId ? [records.get(projectId)].filter((r): r is ImpactRecord => !!r) : [...records.values()];
  const households = list.reduce((s, r) => s + r.householdsElectrified, 0);
  const incomeGain = list.reduce((s, r) => s + (r.incomeAfter - r.incomeBefore) * 12 * r.householdsElectrified, 0);
  return {
    projects: list.length,
    householdsElectrified: households,
    jobsCreated: list.reduce((s, r) => s + r.jobsCreated, 0),
    annualIncomeGainUsd: round2(incomeGain),
    avgIncomeImprovementPct: round2(
      households > 0 ? (list.reduce((s, r) => s + pct(r) * r.householdsElectrified, 0) / households) : 0,
    ),
    kwhDelivered: list.reduce((s, r) => s + r.kwhDelivered, 0),
    co2AvoidedTonnes: round2(list.reduce((s, r) => s + r.kwhDelivered * PROXIES.co2PerKwh, 0)),
    investmentUsd: list.reduce((s, r) => s + r.investmentUsd, 0),
  };
}

export function sdgAlignment(projectId?: string) {
  const t = totals(projectId);
  return [
    { sdg: 7, name: "Affordable and Clean Energy", indicators: { householdsElectrified: t.householdsElectrified, kwhDelivered: t.kwhDelivered } },
    { sdg: 8, name: "Decent Work and Economic Growth", indicators: { jobsCreated: t.jobsCreated, annualIncomeGainUsd: t.annualIncomeGainUsd } },
    { sdg: 13, name: "Climate Action", indicators: { co2AvoidedTonnes: t.co2AvoidedTonnes } },
  ];
}

/** SROI = monetised annual social value / investment. */
export function sroi(projectId?: string) {
  const t = totals(projectId);
  const value =
    t.householdsElectrified * PROXIES.perHouseholdYear +
    t.jobsCreated * PROXIES.perJobYear +
    t.annualIncomeGainUsd +
    t.co2AvoidedTonnes * PROXIES.perTonneCo2;
  return { socialValueUsd: round2(value), investmentUsd: t.investmentUsd, ratio: t.investmentUsd > 0 ? round2(value / t.investmentUsd) : 0 };
}

export function investorReport(projectId?: string) {
  return {
    generatedAt: new Date().toISOString(),
    scope: projectId ?? "portfolio",
    totals: totals(projectId),
    sdgs: sdgAlignment(projectId),
    sroi: sroi(projectId),
    stories: listStories(projectId).slice(-5),
  };
}

function pct(r: ImpactRecord): number {
  return r.incomeBefore > 0 ? ((r.incomeAfter - r.incomeBefore) / r.incomeBefore) * 100 : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
