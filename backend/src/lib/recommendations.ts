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

export type RecommendationStatus = "pending" | "accepted" | "dismissed";

export interface Recommendation {
  id: number;
  meterId: string;
  kind: string;
  message: string;
  estimatedWeeklySavingKwh: number;
  score: number;
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

type Candidate = { kind: string; message: string; saving: number; feature: number };

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
      status TEXT NOT NULL DEFAULT 'pending',
      week_of TEXT NOT NULL,
      created_at TEXT NOT NULL,
      baseline_weekly_kwh REAL,
      UNIQUE (meter_id, kind, week_of)
    );
    CREATE INDEX IF NOT EXISTS idx_recs_meter ON recommendations(meter_id, week_of);
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
  return d;
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
       (meter_id, kind, message, estimated_saving_kwh, score, week_of, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const dismissedKinds = new Set(
    (db()
      .prepare("SELECT kind FROM recommendations WHERE meter_id = ? AND status = 'dismissed' AND week_of = ?")
      .all(meterId, week) as Array<{ kind: string }>).map((r) => r.kind),
  );
  const ranked = candidates(f)
    .filter((c) => !dismissedKinds.has(c.kind))
    .map((c) => ({ c, s: score(meterId, c, f.weeklyKwh) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max);
  const now = new Date().toISOString();
  for (const { c, s } of ranked) {
    insert.run(meterId, c.kind, c.message, Number(c.saving.toFixed(3)), Number(s.toFixed(4)), week, now);
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
  return mapRow(d.prepare("SELECT * FROM recommendations WHERE id = ?").get(id), kwhBetween(meterId, 7, 0));
}

export function savingsSummary(meterId: string) {
  const recs = listRecommendations(meterId).filter((r) => r.status === "accepted");
  const estimated = recs.reduce((s, r) => s + r.estimatedWeeklySavingKwh, 0);
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
  };
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
