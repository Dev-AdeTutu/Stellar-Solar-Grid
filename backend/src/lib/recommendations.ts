/**
 * Energy usage recommendations engine (#895)
 *
 * Features are extracted from each meter's usage_events (last 28 days):
 * weekly kWh, peak-hour share, night-time baseload, weekend ratio, trend and
 * peer comparison. Candidate recommendations are scored with a per-meter
 * logistic model whose weights are learned online from the user's own
 * accept/dismiss feedback, so suggestions become personalised over time.
 *
 * Savings: each recommendation carries an estimated weekly kWh saving. When a
 * recommendation is accepted we snapshot the baseline weekly usage; actual
 * savings = baseline − current weekly usage, tracked against the estimate.
 */
import { initUsageEventStore } from "./usageEvents.js";
import { sendPushToOwner } from "./pushNotifications.js";
import { logger } from "./logger.js";
import { analyzeConsumption } from "./consumptionAnalytics.js";

export type RecommendationStatus = "pending" | "accepted" | "dismissed";
export type RecommendationPriority = "high" | "medium" | "low";

export interface Recommendation {
  id: number;
  meterId: string;
  kind: string;
  message: string;
  estimatedWeeklySavingKwh: number;
  score: number;
  priority: RecommendationPriority;
  status: RecommendationStatus;
  weekOf: string;
  createdAt: string;
  baselineWeeklyKwh: number | null;
  actualWeeklySavingKwh: number | null;
}

export interface UsageFeatures {
  weeklyKwh: number;
  peakShare: number;      // share of usage in 18:00-22:00
  nightBaseKwh: number;   // avg kWh/night 00:00-05:00
  weekendRatio: number;   // weekend daily avg / weekday daily avg
  trendPct: number;       // last week vs previous week
  peerRatio: number;      // weeklyKwh / peer average
}

type Candidate = {
  kind: string;
  message: string;
  saving: number;
  feature: number;
  priority?: RecommendationPriority;
};

const RATE_PER_KWH = Number(process.env.RECOMMENDATION_RATE_PER_KWH ?? 0.15);
const LEARNING_RATE = 0.3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;

function db() {
  const d = initUsageEventStore();
  d.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      estimated_saving_kwh REAL NOT NULL,
      score REAL NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      week_of TEXT NOT NULL,
      created_at TEXT NOT NULL,
      baseline_weekly_kwh REAL,
      UNIQUE (meter_id, kind, week_of)
    );
    CREATE INDEX IF NOT EXISTS idx_recs_meter ON recommendations(meter_id, week_of);
    CREATE TABLE IF NOT EXISTS recommendation_adoption (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL,
      meter_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      adopted_at TEXT NOT NULL,
      baseline_weekly_kwh REAL,
      measured_weekly_kwh REAL,
      measured_saving_kwh REAL,
      estimated_saving_kwh REAL,
      impact_pct REAL,
      UNIQUE (recommendation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_adoption_meter ON recommendation_adoption(meter_id);
    CREATE TABLE IF NOT EXISTS recommendation_weights (
      meter_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (meter_id, kind)
    );
    CREATE TABLE IF NOT EXISTS recommendation_subscribers (
      meter_id TEXT PRIMARY KEY,
      owner_address TEXT NOT NULL
    );
  `);
  migrate(d);
  return d;
}

/** Add the priority column to pre-existing databases. */
function migrate(d: ReturnType<typeof db>): void {
  const cols = d.prepare("PRAGMA table_info(recommendations)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "priority")) {
    d.exec("ALTER TABLE recommendations ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
  }
}

function weekOf(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function kwhBetween(meterId: string, fromDaysAgo: number, toDaysAgo: number): number {
  const row = db()
    .prepare(
      `SELECT COALESCE(SUM(CAST(units AS REAL)), 0) / 1000.0 AS kwh FROM usage_events
       WHERE meter_id = ? AND status IN ('submitted','pending')
         AND received_at >= datetime('now', '-' || ? || ' days')
         AND received_at < datetime('now', '-' || ? || ' days')`,
    )
    .get(meterId, fromDaysAgo, toDaysAgo) as { kwh: number };
  return row.kwh;
}

export function extractFeatures(meterId: string): UsageFeatures {
  const d = db();
  const hourly = d
    .prepare(
      `SELECT CAST(strftime('%H', received_at) AS INTEGER) AS h,
              CAST(strftime('%w', received_at) AS INTEGER) AS dow,
              SUM(CAST(units AS REAL)) / 1000.0 AS kwh
       FROM usage_events
       WHERE meter_id = ? AND status IN ('submitted','pending')
         AND received_at >= datetime('now', '-28 days')
       GROUP BY h, dow`,
    )
    .all(meterId) as Array<{ h: number; dow: number; kwh: number }>;

  let total = 0, peak = 0, night = 0, weekend = 0, weekday = 0;
  for (const r of hourly) {
    total += r.kwh;
    if (r.h >= 18 && r.h < 22) peak += r.kwh;
    if (r.h < 5) night += r.kwh;
    if (r.dow === 0 || r.dow === 6) weekend += r.kwh;
    else weekday += r.kwh;
  }
  const weeklyKwh = kwhBetween(meterId, 7, 0);
  const prevKwh = kwhBetween(meterId, 14, 7);
  const peer = d
    .prepare(
      `SELECT AVG(k) AS avg FROM (
         SELECT SUM(CAST(units AS REAL)) / 1000.0 AS k FROM usage_events
         WHERE status IN ('submitted','pending') AND received_at >= datetime('now', '-7 days')
         GROUP BY meter_id)`,
    )
    .get() as { avg: number | null };

  return {
    weeklyKwh,
    peakShare: total ? peak / total : 0,
    nightBaseKwh: night / 28,
    weekendRatio: weekday ? (weekend / 2) / (weekday / 5) : 1,
    trendPct: prevKwh ? ((weeklyKwh - prevKwh) / prevKwh) * 100 : 0,
    peerRatio: peer.avg ? weeklyKwh / peer.avg : 1,
  };
}

/** Rule-based candidate generation; `feature` is a 0-1 signal strength. */
function candidates(f: UsageFeatures): Candidate[] {
  const out: Candidate[] = [];
  if (f.peakShare > 0.3) {
    out.push({
      kind: "shift_peak",
      message: `${Math.round(f.peakShare * 100)}% of your usage is between 6–10 PM. Shift laundry or water heating to midday when solar output peaks.`,
      saving: f.weeklyKwh * f.peakShare * 0.2,
      feature: Math.min(1, f.peakShare),
    });
  }
  if (f.nightBaseKwh > 0.3) {
    out.push({
      kind: "reduce_standby",
      message: `Your meter draws about ${f.nightBaseKwh.toFixed(2)} kWh overnight. Unplug idle chargers and appliances on standby.`,
      saving: f.nightBaseKwh * 7 * 0.4,
      feature: Math.min(1, f.nightBaseKwh / 2),
    });
  }
  if (f.peerRatio > 1.2) {
    out.push({
      kind: "peer_gap",
      message: `You used ${Math.round((f.peerRatio - 1) * 100)}% more than similar households this week. Switching to LED lighting typically saves 10%.`,
      saving: f.weeklyKwh * 0.1,
      feature: Math.min(1, f.peerRatio - 1),
    });
  }
  if (f.trendPct > 15) {
    out.push({
      kind: "rising_trend",
      message: `Usage rose ${Math.round(f.trendPct)}% versus last week. Check for appliances left running.`,
      saving: f.weeklyKwh * (f.trendPct / 100) * 0.5,
      feature: Math.min(1, f.trendPct / 100),
    });
  }
  if (f.weekendRatio > 1.4) {
    out.push({
      kind: "weekend_usage",
      message: "Weekend usage is much higher than weekdays. Batch cooking and run heavy appliances during daylight hours.",
      saving: f.weeklyKwh * 0.05,
      feature: Math.min(1, f.weekendRatio - 1),
    });
  }
  if (f.weeklyKwh > 0) {
    out.push({
      kind: "efficient_appliances",
      message: "Keep fridge seals clean and set it to 4°C — an easy 5% saving on refrigeration.",
      saving: f.weeklyKwh * 0.03,
      feature: 0.2,
    });
  }
  return out;
}

/** Derive a priority label from the relative weekly saving and signal strength. */
function priorityFor(saving: number, weeklyKwh: number, feature: number): RecommendationPriority {
  const rel = weeklyKwh > 0 ? saving / weeklyKwh : 0;
  const impact = rel * 0.7 + feature * 0.3;
  if (impact >= 0.08) return "high";
  if (impact >= 0.03) return "medium";
  return "low";
}

/**
 * Pattern-based candidates derived from consumptionAnalytics: peak times,
 * anomalies and trends. These are merged with the rule-based candidates.
 */
function patternCandidates(meterId: string, f: UsageFeatures): Candidate[] {
  let analysis: ReturnType<typeof analyzeConsumption>;
  try {
    analysis = analyzeConsumption(meterId);
  } catch (err) {
    logger.warn({ err, meterId }, "Consumption pattern analysis failed");
    return [];
  }
  const out: Candidate[] = [];
  const weekly = f.weeklyKwh || analysis.totalKwh || 0;

  // Peak-time shifting based on the detected peak window.
  const peak = analysis.peakHours?.[0];
  if (peak && peak.share > 0.25) {
    const saving = weekly * peak.share * 0.25;
    out.push({
      kind: "pattern_shift_peak",
      message: `Your usage peaks around ${String(peak.hour).padStart(2, "0")}:00 (${Math.round(
        peak.share * 100,
      )}% of consumption). Shift flexible loads such as laundry or EV charging outside this window.`,
      saving,
      feature: Math.min(1, peak.share),
      priority: priorityFor(saving, weekly, Math.min(1, peak.share)),
    });
  }

  // Anomalies: sudden spikes worth investigating.
  const anomalies = (analysis.anomalies ?? []).slice(0, 2);
  for (const a of anomalies) {
    const saving = weekly * 0.08;
    out.push({
      kind: "pattern_anomaly",
      message: `Unusual consumption detected${
        a.timestamp ? ` around ${String(a.timestamp).slice(0, 16).replace("T", " ")}` : ""
      }. Check for faulty appliances or devices left running.`,
      saving,
      feature: 0.6,
      priority: priorityFor(saving, weekly, 0.6),
    });
  }

  // Trend: sustained increase suggests an appliance upgrade opportunity.
  const trendPct = analysis.trendPct ?? f.trendPct;
  if (trendPct > 10) {
    const saving = weekly * Math.min(0.2, (trendPct / 100) * 0.6);
    out.push({
      kind: "pattern_upgrade_appliance",
      message: `Consumption is trending up ${Math.round(
        trendPct,
      )}%. Consider upgrading the oldest high-draw appliance (fridge, water heater or HVAC) to a high-efficiency model.`,
      saving,
      feature: Math.min(1, trendPct / 100),
      priority: priorityFor(saving, weekly, Math.min(1, trendPct / 100)),
    });
  }

  return out;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function weightFor(meterId: string, kind: string): number {
  const row = db()
    .prepare("SELECT weight FROM recommendation_weights WHERE meter_id = ? AND kind = ?")
    .get(meterId, kind) as { weight: number } | undefined;
  return row?.weight ?? 0;
}

/** Score = P(accept) from the per-meter logistic model × relative saving. */
function score(meterId: string, c: Candidate, weeklyKwh: number): number {
  const pAccept = sigmoid(weightFor(meterId, c.kind) + 2 * c.feature - 1);
  const relSaving = weeklyKwh ? c.saving / weeklyKwh : 0;
  return pAccept * (0.5 + relSaving);
}

function mapRow(r: Record<string, unknown>, currentWeeklyKwh?: number): Recommendation {
  const baseline = r.baseline_weekly_kwh as number | null;
  return {
    id: Number(r.id),
    meterId: String(r.meter_id),
    kind: String(r.kind),
    message: String(r.message),
    estimatedWeeklySavingKwh: Number(r.estimated_saving_kwh),
    score: Number(r.score),
    priority: (r.priority as RecommendationPriority) ?? "medium",
    status: r.status as RecommendationStatus,
    weekOf: String(r.week_of),
    createdAt: String(r.created_at),
    baselineWeeklyKwh: baseline,
    actualWeeklySavingKwh:
      r.status === "accepted" && baseline !== null && currentWeeklyKwh !== undefined
        ? Math.max(0, baseline - currentWeeklyKwh)
        : null,
  };
}

/** Generate (idempotently) this week's top recommendations for a meter. */
export function generateWeekly(meterId: string, max = 3): Recommendation[] {
  const f = extractFeatures(meterId);
  const week = weekOf();
  const insert = db().prepare(
    `INSERT OR IGNORE INTO recommendations
       (meter_id, kind, message, estimated_saving_kwh, score, priority, week_of, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dismissedKinds = new Set(
    (db()
      .prepare("SELECT kind FROM recommendations WHERE meter_id = ? AND status = 'dismissed' AND week_of = ?")
      .all(meterId, week) as Array<{ kind: string }>).map((r) => r.kind),
  );
  const merged = [...candidates(f), ...patternCandidates(meterId, f)];
  const seen = new Set<string>();
  const ranked = merged
    .filter((c) => !dismissedKinds.has(c.kind))
    .filter((c) => (seen.has(c.kind) ? false : (seen.add(c.kind), true)))
    .map((c) => ({ c, s: score(meterId, c, f.weeklyKwh) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max);
  const now = new Date().toISOString();
  for (const { c, s } of ranked) {
    const priority = c.priority ?? priorityFor(c.saving, f.weeklyKwh, c.feature);
    insert.run(
      meterId,
      c.kind,
      c.message,
      Number(c.saving.toFixed(3)),
      Number(s.toFixed(4)),
      priority,
      week,
      now,
    );
  }
  return listRecommendations(meterId);
}

export function listRecommendations(meterId: string): Recommendation[] {
  const current = kwhBetween(meterId, 7, 0);
  return (db()
    .prepare("SELECT * FROM recommendations WHERE meter_id = ? ORDER BY week_of DESC, score DESC LIMIT 50")
    .all(meterId) as Array<Record<string, unknown>>).map((r) => mapRow(r, current));
}

/** Accept/dismiss feedback — updates the per-meter model weight (online SGD). */
export function respond(meterId: string, id: number, action: "accept" | "dismiss"): Recommendation | null {
  const d = db();
  const row = d.prepare("SELECT * FROM recommendations WHERE id = ? AND meter_id = ?").get(id, meterId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const label = action === "accept" ? 1 : 0;
  const w = weightFor(meterId, String(row.kind));
  const next = w + LEARNING_RATE * (label - sigmoid(w));
  d.prepare(
    `INSERT INTO recommendation_weights (meter_id, kind, weight) VALUES (?, ?, ?)
     ON CONFLICT(meter_id, kind) DO UPDATE SET weight = excluded.weight`,
  ).run(meterId, row.kind, next);
  const baseline = action === "accept" ? kwhBetween(meterId, 7, 0) : null;
  d.prepare("UPDATE recommendations SET status = ?, baseline_weekly_kwh = ? WHERE id = ?").run(
    action === "accept" ? "accepted" : "dismissed",
    baseline,
    id,
  );
  if (action === "accept") {
    recordAdoption(meterId, id, String(row.kind), baseline, Number(row.estimated_saving_kwh));
  }
  return mapRow(d.prepare("SELECT * FROM recommendations WHERE id = ?").get(id), kwhBetween(meterId, 7, 0));
}

/** Record that a recommendation was adopted, snapshotting its baseline. */
export function recordAdoption(
  meterId: string,
  recommendationId: number,
  kind: string,
  baselineWeeklyKwh: number | null,
  estimatedSavingKwh: number,
): void {
  db()
    .prepare(
      `INSERT INTO recommendation_adoption
         (recommendation_id, meter_id, kind, adopted_at, baseline_weekly_kwh, estimated_saving_kwh)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(recommendation_id) DO UPDATE SET
         baseline_weekly_kwh = excluded.baseline_weekly_kwh,
         estimated_saving_kwh = excluded.estimated_saving_kwh`,
    )
    .run(recommendationId, meterId, kind, new Date().toISOString(), baselineWeeklyKwh, estimatedSavingKwh);
}

/** Measure the realised impact of adopted recommendations against their baseline. */
export function measureAdoptionImpact(meterId: string): Array<{
  recommendationId: number;
  kind: string;
  estimatedWeeklySavingKwh: number;
  measuredWeeklySavingKwh: number;
  impactPct: number | null;
}> {
  const d = db();
  const current = kwhBetween(meterId, 7, 0);
  const rows = d
    .prepare("SELECT * FROM recommendation_adoption WHERE meter_id = ?")
    .all(meterId) as Array<Record<string, unknown>>;
  const out: Array<{
    recommendationId: number;
    kind: string;
    estimatedWeeklySavingKwh: number;
    measuredWeeklySavingKwh: number;
    impactPct: number | null;
  }> = [];
  for (const r of rows) {
    const baseline = r.baseline_weekly_kwh as number | null;
    const estimated = Number(r.estimated_saving_kwh ?? 0);
    const measured = baseline !== null ? Math.max(0, baseline - current) : 0;
    const impactPct = estimated ? Number(((measured / estimated) * 100).toFixed(1)) : null;
    d.prepare(
      `UPDATE recommendation_adoption
         SET measured_weekly_kwh = ?, measured_saving_kwh = ?, impact_pct = ?
       WHERE recommendation_id = ?`,
    ).run(current, Number(measured.toFixed(3)), impactPct, r.recommendation_id);
    out.push({
      recommendationId: Number(r.recommendation_id),
      kind: String(r.kind),
      estimatedWeeklySavingKwh: estimated,
      measuredWeeklySavingKwh: Number(measured.toFixed(3)),
      impactPct,
    });
  }
  return out;
}

/** Adoption statistics for a meter: how many recommendations were taken up. */
export function adoptionSummary(meterId: string) {
  const d = db();
  const total = (d
    .prepare("SELECT COUNT(*) AS n FROM recommendations WHERE meter_id = ?")
    .get(meterId) as { n: number }).n;
  const adopted = (d
    .prepare("SELECT COUNT(*) AS n FROM recommendation_adoption WHERE meter_id = ?")
    .get(meterId) as { n: number }).n;
  const impacts = measureAdoptionImpact(meterId);
  const measured = impacts.reduce((s, i) => s + i.measuredWeeklySavingKwh, 0);
  return {
    totalRecommendations: total,
    adoptedCount: adopted,
    adoptionRatePct: total ? Number(((adopted / total) * 100).toFixed(1)) : 0,
    measuredWeeklySavingKwh: Number(measured.toFixed(3)),
  };
}

export function savingsSummary(meterId: string) {
  const recs = listRecommendations(meterId).filter((r) => r.status === "accepted");
  const estimated = recs.reduce((s, r) => s + r.estimatedWeeklySavingKwh, 0);
  const adoption = adoptionSummary(meterId);
  // Actual saving is measured once per meter (baseline from the earliest acceptance)
  // so overlapping recommendations aren't double counted.
  const earliest = recs.reduce<Recommendation | null>(
    (a, r) => (!a || r.createdAt < a.createdAt ? r : a),
    null,
  );
  const actual = earliest?.actualWeeklySavingKwh ?? 0;
  return {
    acceptedCount: recs.length,
    estimatedWeeklySavingKwh: Number(estimated.toFixed(3)),
    actualWeeklySavingKwh: Number(actual.toFixed(3)),
    estimatedWeeklySavingCost: Number((estimated * RATE_PER_KWH).toFixed(2)),
    actualWeeklySavingCost: Number((actual * RATE_PER_KWH).toFixed(2)),
    accuracyPct: estimated ? Number(((actual / estimated) * 100).toFixed(1)) : null,
    adoptionRatePct: adoption.adoptionRatePct,
    adoptedCount: adoption.adoptedCount,
  };
}

export interface ApplianceBreakdownEntry {
  appliance: string;
  kwh: number;
  share: number; // 0-1 fraction of total consumption
}

export interface ApplianceRecommendation {
  appliance: string;
  kind: string;
  message: string;
  share: number;
  estimatedWeeklySavingKwh: number;
  estimatedWeeklySavingXlm: number;
  score: number;
}

const APPLIANCE_SHARE_THRESHOLD = Number(process.env.APPLIANCE_SHARE_THRESHOLD ?? 0.15);

/** Per-appliance saving tips, personalised via the same accept/dismiss model. */
function applianceTip(
  appliance: string,
  share: number,
  weeklyKwh: number,
): { message: string; saving: number; feature: number } {
  const pct = Math.round(share * 100);
  const kwh = weeklyKwh * share;
  const name = appliance.toLowerCase();
  if (name.includes("hvac") || name.includes("heat") || name.includes("cool") || name.includes("air")) {
    return {
      message: `Your ${appliance} uses ${pct}% of consumption — setting the thermostat 2°C lower saves ~${(kwh * 0.12).toFixed(1)} kWh/week.`,
      saving: kwh * 0.12,
      feature: Math.min(1, share),
    };
  }
  if (name.includes("water") || name.includes("boiler") || name.includes("geyser")) {
    return {
      message: `Your ${appliance} uses ${pct}% of consumption — lowering the tank setpoint to 55°C saves ~${(kwh * 0.1).toFixed(1)} kWh/week.`,
      saving: kwh * 0.1,
      feature: Math.min(1, share),
    };
  }
  if (name.includes("fridge") || name.includes("freezer") || name.includes("refriger")) {
    return {
      message: `Your ${appliance} uses ${pct}% of consumption — cleaning seals and setting it to 4°C saves ~${(kwh * 0.08).toFixed(1)} kWh/week.`,
      saving: kwh * 0.08,
      feature: Math.min(1, share),
    };
  }
  if (name.includes("washer") || name.includes("laundry") || name.includes("dryer")) {
    return {
      message: `Your ${appliance} uses ${pct}% of consumption — washing at 30°C and air-drying saves ~${(kwh * 0.15).toFixed(1)} kWh/week.`,
      saving: kwh * 0.15,
      feature: Math.min(1, share),
    };
  }
  if (name.includes("light") || name.includes("lamp")) {
    return {
      message: `Your ${appliance} uses ${pct}% of consumption — switching to LEDs saves ~${(kwh * 0.2).toFixed(1)} kWh/week.`,
      saving: kwh * 0.2,
      feature: Math.min(1, share),
    };
  }
  return {
    message: `Your ${appliance} uses ${pct}% of consumption — scheduling it off-peak saves ~${(kwh * 0.1).toFixed(1)} kWh/week.`,
    saving: kwh * 0.1,
    feature: Math.min(1, share),
  };
}

/**
 * Generate targeted saving tips for each appliance above the share threshold.
 * Tips are ranked with the same per-meter logistic model used for weekly
 * recommendations, so accept/dismiss feedback personalises them over time.
 */
export function generateApplianceRecommendations(
  meterId: string,
  breakdown: ApplianceBreakdownEntry[],
  threshold = APPLIANCE_SHARE_THRESHOLD,
): ApplianceRecommendation[] {
  const weeklyKwh = breakdown.reduce((s, b) => s + b.kwh, 0);
  return breakdown
    .filter((b) => b.share >= threshold && b.kwh > 0)
    .map((b) => {
      const kind = `appliance_${b.appliance.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      const tip = applianceTip(b.appliance, b.share, weeklyKwh);
      const c: Candidate = { kind, message: tip.message, saving: tip.saving, feature: tip.feature };
      return {
        appliance: b.appliance,
        kind,
        message: tip.message,
        share: b.share,
        estimatedWeeklySavingKwh: Number(tip.saving.toFixed(3)),
        estimatedWeeklySavingXlm: Number((tip.saving * RATE_PER_KWH).toFixed(4)),
        score: Number(score(meterId, c, weeklyKwh).toFixed(4)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function subscribe(meterId: string, ownerAddress: string) {
  db()
    .prepare(
      `INSERT INTO recommendation_subscribers (meter_id, owner_address) VALUES (?, ?)
       ON CONFLICT(meter_id) DO UPDATE SET owner_address = excluded.owner_address`,
    )
    .run(meterId, ownerAddress);
}

/** Weekly job: generate recommendations for subscribed meters and notify owners. */
export async function runWeeklyNotifications(): Promise<number> {
  const subs = db().prepare("SELECT meter_id, owner_address FROM recommendation_subscribers").all() as Array<{
    meter_id: string;
    owner_address: string;
  }>;
  let sent = 0;
  for (const s of subs) {
    try {
      const recs = generateWeekly(s.meter_id).filter((r) => r.status === "pending" && r.weekOf === weekOf());
      if (!recs.length) continue;
      const total = recs.reduce((a, r) => a + r.estimatedWeeklySavingKwh, 0);
      await sendPushToOwner(s.owner_address, {
        title: "Your weekly energy tips",
        body: `${recs.length} new tips could save ~${total.toFixed(1)} kWh this week.`,
        tag: `recs-${s.meter_id}-${weekOf()}`,
        url: `/dashboard?meter=${encodeURIComponent(s.meter_id)}`,
      });
      sent++;
    } catch (err) {
      logger.warn({ err, meterId: s.meter_id }, "Weekly recommendation notification failed");
    }
  }
  return sent;
}

export function startRecommendationWorker() {
  if (timer) return;
  timer = setInterval(() => void runWeeklyNotifications(), WEEK_MS);
  timer.unref?.();
}
