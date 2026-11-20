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
  /**
   * Identity of the physical asset this record measures. Records that share an
   * assetId describe the same physical asset (e.g. a solar array shared between
   * communities) and must not have their generation counted more than once.
   * Defaults to projectId when omitted.
   */
  assetId?: string;
  /**
   * This community's ownership/share weight in the asset, in [0, 1]. When
   * several records reference the same asset, kwhDelivered is attributed once
   * and split proportionally by these weights. Defaults to 1.
   */
  share?: number;
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

function assetKey(r: ImpactRecord): string {
  return r.assetId ?? r.projectId;
}

/**
 * Attribute each asset's generation once across the records that reference it.
 * Returns a map from record projectId to the kwhDelivered attributable to that
 * record. For an asset referenced by a single record the full generation is
 * attributed; for an asset shared by several records the generation is split
 * proportionally by share weight so the combined total equals the asset's
 * actual generation rather than the sum over all referencing communities.
 */
function attributedKwh(list: ImpactRecord[]): Map<string, number> {
  const byAsset = new Map<string, ImpactRecord[]>();
  for (const r of list) {
    const key = assetKey(r);
    const group = byAsset.get(key);
    if (group) group.push(r);
    else byAsset.set(key, [r]);
  }
  const result = new Map<string, number>();
  for (const group of byAsset.values()) {
    if (group.length === 1) {
      result.set(group[0].projectId, group[0].kwhDelivered);
      continue;
    }
    // Shared asset: count its generation once, split by ownership weight.
    const totalWeight = group.reduce((s, r) => s + Math.max(0, r.share ?? 1), 0);
    const assetKwh = Math.max(...group.map((r) => r.kwhDelivered));
    for (const r of group) {
      const weight = Math.max(0, r.share ?? 1);
      const share = totalWeight > 0 ? weight / totalWeight : 1 / group.length;
      result.set(r.projectId, assetKwh * share);
    }
  }
  return result;
}

export function totals(projectId?: string) {
  const list = projectId ? [records.get(projectId)].filter((r): r is ImpactRecord => !!r) : [...records.values()];
  const households = list.reduce((s, r) => s + r.householdsElectrified, 0);
  const incomeGain = list.reduce((s, r) => s + (r.incomeAfter - r.incomeBefore) * 12 * r.householdsElectrified, 0);
  const kwhByProject = attributedKwh(list);
  const kwhDelivered = list.reduce((s, r) => s + (kwhByProject.get(r.projectId) ?? 0), 0);
  return {
    projects: list.length,
    householdsElectrified: households,
    jobsCreated: list.reduce((s, r) => s + r.jobsCreated, 0),
    annualIncomeGainUsd: round2(incomeGain),
    avgIncomeImprovementPct: round2(
      households > 0 ? (list.reduce((s, r) => s + pct(r) * r.householdsElectrified, 0) / households) : 0,
    ),
    kwhDelivered: round2(kwhDelivered),
    co2AvoidedTonnes: round2(kwhDelivered * PROXIES.co2PerKwh),
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
