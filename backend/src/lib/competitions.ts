/**
 * Energy trading competitions (#903).
 *
 * Competition types and how participants are scored:
 *   - efficiency   — % reduction in average daily consumption versus a
 *                    baseline window of equal length immediately before the
 *                    competition. Computed from recorded usage events.
 *   - trading      — total energy traded (units) reported via recordMetric().
 *   - green_energy — total renewable energy (units) reported via recordMetric().
 * Higher score ranks higher in every type.
 *
 * Lifecycle: scheduled → active → completed (or cancelled). The scheduler
 * creates one competition per enabled type for each calendar month, starts
 * and ends them on time, ranks the final leaderboard and awards the prizes
 * configured in the competition's rules. Prizes are paid in XLM from the
 * admin account when COMPETITION_PAYOUTS_ENABLED=true; otherwise they stay
 * "pending" until an operator enables payouts and retries them.
 */
import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { getUsageTotals, STROOPS_PER_XLM } from "./billing.js";
import { logger } from "./logger.js";

const DB_PATH =
  process.env.COMPETITIONS_DB_PATH ?? path.resolve(process.cwd(), "data", "competitions.sqlite");
const SCHEDULER_INTERVAL_MS = Number(process.env.COMPETITION_SCHEDULER_INTERVAL_MS ?? 5 * 60 * 1000);

export const COMPETITION_TYPES = ["efficiency", "trading", "green_energy"] as const;
export type CompetitionType = (typeof COMPETITION_TYPES)[number];
export type CompetitionStatus = "scheduled" | "active" | "completed" | "cancelled";
export type PrizeStatus = "pending" | "processing" | "paid" | "failed";

export type CompetitionRules = {
  /** Prize per rank in stroops; index 0 is 1st place. */
  prizes: number[];
  /** Competition is cancelled (no prizes) with fewer scored participants. */
  minParticipants: number;
  /** Optional cap on participants; null = unlimited. */
  maxParticipants: number | null;
  /** efficiency only: minimum baseline units for a participant to be ranked. */
  minBaselineUnits: number;
};

export type Competition = {
  id: string;
  name: string;
  type: CompetitionType;
  status: CompetitionStatus;
  starts_at: string;
  ends_at: string;
  rules: CompetitionRules;
  schedule_key: string | null;
  created_at: string;
  finalized_at: string | null;
};

export type Participant = {
  competition_id: string;
  meter_id: string;
  stellar_address: string;
  display_name: string | null;
  joined_at: string;
};

export type LeaderboardEntry = {
  rank: number;
  meterId: string;
  displayName: string | null;
  score: number;
  detail: Record<string, number>;
};

export type Prize = {
  competition_id: string;
  rank: number;
  meter_id: string;
  stellar_address: string;
  amount: number;
  status: PrizeStatus;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  paid_at: string | null;
};

type CompetitionRow = Omit<Competition, "rules"> & { rules: string };

// ── Storage ──────────────────────────────────────────────────────────────────

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS competitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        rules TEXT NOT NULL,
        schedule_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        finalized_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions (status, ends_at);
      CREATE TABLE IF NOT EXISTS competition_participants (
        competition_id TEXT NOT NULL,
        meter_id TEXT NOT NULL,
        stellar_address TEXT NOT NULL,
        display_name TEXT,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (competition_id, meter_id)
      );
      CREATE TABLE IF NOT EXISTS competition_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competition_id TEXT NOT NULL,
        meter_id TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_competition_metrics ON competition_metrics (competition_id, meter_id);
      CREATE TABLE IF NOT EXISTS competition_prizes (
        competition_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        meter_id TEXT NOT NULL,
        stellar_address TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT,
        PRIMARY KEY (competition_id, rank)
      );
    `);
  }
  return _db;
}

registerDatabase("competitions", () => {
  _db?.close();
  _db = undefined;
});

// ── Live updates ─────────────────────────────────────────────────────────────

const events = new EventEmitter();
events.setMaxListeners(1000);

/** Subscribe to "something changed" notifications for a competition's leaderboard. */
export function onLeaderboardChange(competitionId: string, listener: () => void): () => void {
  events.on(competitionId, listener);
  return () => events.off(competitionId, listener);
}

function notify(competitionId: string) {
  events.emit(competitionId);
}

// ── Rules ────────────────────────────────────────────────────────────────────

function parseXlmList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const values = raw.split(",").map((v) => Math.round(Number(v.trim()) * STROOPS_PER_XLM));
  return values.every((v) => Number.isFinite(v) && v >= 0) ? values : fallback;
}

export function defaultRules(): CompetitionRules {
  return {
    prizes: parseXlmList(process.env.COMPETITION_DEFAULT_PRIZES_XLM, [50, 25, 10].map((x) => x * STROOPS_PER_XLM)),
    minParticipants: Number(process.env.COMPETITION_MIN_PARTICIPANTS ?? 3),
    maxParticipants: process.env.COMPETITION_MAX_PARTICIPANTS ? Number(process.env.COMPETITION_MAX_PARTICIPANTS) : null,
    minBaselineUnits: Number(process.env.COMPETITION_MIN_BASELINE_UNITS ?? 1),
  };
}

/** Validate a partial rules object; returns an error message or the merged rules. */
export function mergeRules(base: CompetitionRules, patch: unknown): CompetitionRules | string {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object") return "rules must be an object";
  const p = patch as Partial<CompetitionRules>;
  const out = { ...base };
  if (p.prizes !== undefined) {
    if (!Array.isArray(p.prizes) || p.prizes.length > 100 || !p.prizes.every((v) => Number.isInteger(v) && v >= 0)) {
      return "rules.prizes must be an array of non-negative integer stroop amounts (max 100)";
    }
    out.prizes = p.prizes;
  }
  if (p.minParticipants !== undefined) {
    if (!Number.isInteger(p.minParticipants) || p.minParticipants < 1) return "rules.minParticipants must be an integer ≥ 1";
    out.minParticipants = p.minParticipants;
  }
  if (p.maxParticipants !== undefined) {
    if (p.maxParticipants !== null && (!Number.isInteger(p.maxParticipants) || p.maxParticipants < 1)) {
      return "rules.maxParticipants must be null or an integer ≥ 1";
    }
    out.maxParticipants = p.maxParticipants;
  }
  if (p.minBaselineUnits !== undefined) {
    if (typeof p.minBaselineUnits !== "number" || p.minBaselineUnits < 0) return "rules.minBaselineUnits must be ≥ 0";
    out.minBaselineUnits = p.minBaselineUnits;
  }
  return out;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function toCompetition(row: CompetitionRow): Competition {
  return { ...row, rules: JSON.parse(row.rules) };
}

export function getCompetition(id: string): Competition | undefined {
  const row = db().prepare("SELECT * FROM competitions WHERE id = ?").get(id) as CompetitionRow | undefined;
  return row ? toCompetition(row) : undefined;
}

export function listCompetitions(filter: { status?: CompetitionStatus; type?: CompetitionType } = {}, limit = 50): Competition[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  const rows = db()
    .prepare(
      `SELECT * FROM competitions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY starts_at DESC LIMIT ?`,
    )
    .all(...params, limit) as CompetitionRow[];
  return rows.map(toCompetition);
}

export function createCompetition(input: {
  name: string;
  type: CompetitionType;
  startsAt: Date;
  endsAt: Date;
  rules?: CompetitionRules;
  scheduleKey?: string;
  now?: Date;
}): Competition {
  const now = input.now ?? new Date();
  const id = crypto.randomUUID();
  const status: CompetitionStatus = input.startsAt <= now ? "active" : "scheduled";
  db()
    .prepare(
      `INSERT INTO competitions (id, name, type, status, starts_at, ends_at, rules, schedule_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.type,
      status,
      input.startsAt.toISOString(),
      input.endsAt.toISOString(),
      JSON.stringify(input.rules ?? defaultRules()),
      input.scheduleKey ?? null,
      now.toISOString(),
    );
  return getCompetition(id)!;
}

/** Update name/rules/end date. Rules are frozen once a competition completes. */
export function updateCompetition(
  id: string,
  patch: { name?: string; rules?: CompetitionRules; endsAt?: Date },
): Competition | undefined {
  const c = getCompetition(id);
  if (!c) return undefined;
  db()
    .prepare("UPDATE competitions SET name = ?, rules = ?, ends_at = ? WHERE id = ?")
    .run(patch.name ?? c.name, JSON.stringify(patch.rules ?? c.rules), (patch.endsAt ?? new Date(c.ends_at)).toISOString(), id);
  notify(id);
  return getCompetition(id);
}

export function cancelCompetition(id: string): Competition | undefined {
  db()
    .prepare("UPDATE competitions SET status = 'cancelled', finalized_at = ? WHERE id = ? AND status IN ('scheduled','active')")
    .run(new Date().toISOString(), id);
  notify(id);
  return getCompetition(id);
}

// ── Participation ────────────────────────────────────────────────────────────

export function listParticipants(competitionId: string): Participant[] {
  return db()
    .prepare("SELECT * FROM competition_participants WHERE competition_id = ? ORDER BY joined_at")
    .all(competitionId) as Participant[];
}

export type JoinResult = { ok: true; participant: Participant } | { ok: false; status: number; error: string };

export function joinCompetition(
  competitionId: string,
  input: { meterId: string; stellarAddress: string; displayName?: string | null },
  now = new Date(),
): JoinResult {
  const c = getCompetition(competitionId);
  if (!c) return { ok: false, status: 404, error: "Competition not found" };
  if (c.status !== "scheduled" && c.status !== "active") {
    return { ok: false, status: 409, error: `Competition is ${c.status}` };
  }
  if (c.rules.maxParticipants !== null && listParticipants(competitionId).length >= c.rules.maxParticipants) {
    return { ok: false, status: 409, error: "Competition is full" };
  }
  db()
    .prepare(
      `INSERT INTO competition_participants (competition_id, meter_id, stellar_address, display_name, joined_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (competition_id, meter_id) DO UPDATE SET
         stellar_address = excluded.stellar_address, display_name = excluded.display_name`,
    )
    .run(competitionId, input.meterId, input.stellarAddress, input.displayName ?? null, now.toISOString());
  notify(competitionId);
  const participant = db()
    .prepare("SELECT * FROM competition_participants WHERE competition_id = ? AND meter_id = ?")
    .get(competitionId, input.meterId) as Participant;
  return { ok: true, participant };
}

export function leaveCompetition(competitionId: string, meterId: string): boolean {
  const c = getCompetition(competitionId);
  if (!c || c.status === "completed") return false;
  const changes = db()
    .prepare("DELETE FROM competition_participants WHERE competition_id = ? AND meter_id = ?")
    .run(competitionId, meterId).changes;
  if (changes) notify(competitionId);
  return changes > 0;
}

/**
 * Record a trading or green-energy measurement for a participant. Values
 * are ignored outside the competition window or for non-participants.
 */
export function recordMetric(
  competitionId: string,
  meterId: string,
  value: number,
  recordedAt = new Date(),
): { ok: boolean; error?: string } {
  const c = getCompetition(competitionId);
  if (!c) return { ok: false, error: "Competition not found" };
  if (c.type === "efficiency") return { ok: false, error: "efficiency competitions are scored from usage data" };
  if (c.status !== "active") return { ok: false, error: `Competition is ${c.status}` };
  if (recordedAt < new Date(c.starts_at) || recordedAt >= new Date(c.ends_at)) {
    return { ok: false, error: "recordedAt is outside the competition window" };
  }
  const isParticipant = db()
    .prepare("SELECT 1 FROM competition_participants WHERE competition_id = ? AND meter_id = ?")
    .get(competitionId, meterId);
  if (!isParticipant) return { ok: false, error: "meter is not a participant" };
  db()
    .prepare("INSERT INTO competition_metrics (competition_id, meter_id, value, recorded_at) VALUES (?, ?, ?, ?)")
    .run(competitionId, meterId, value, recordedAt.toISOString());
  notify(competitionId);
  return { ok: true };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

const round2 = (v: number) => Math.round(v * 100) / 100;

function scoreEfficiency(c: Competition, meterId: string, now: Date): LeaderboardEntry["detail"] | null {
  const start = new Date(c.starts_at);
  const end = new Date(Math.min(now.getTime(), new Date(c.ends_at).getTime()));
  const elapsedDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (elapsedDays <= 0) return null;
  const baselineDays = (new Date(c.ends_at).getTime() - start.getTime()) / 86_400_000;
  const baselineStart = new Date(start.getTime() - baselineDays * 86_400_000);
  const baseline = getUsageTotals(meterId, baselineStart, start).units;
  if (baseline < c.rules.minBaselineUnits) return null;
  const current = getUsageTotals(meterId, start, end).units;
  const baselineDaily = baseline / baselineDays;
  const currentDaily = current / elapsedDays;
  return {
    score: round2(((baselineDaily - currentDaily) / baselineDaily) * 100),
    baselineDailyUnits: round2(baselineDaily),
    currentDailyUnits: round2(currentDaily),
  };
}

function metricTotals(competitionId: string): Map<string, { total: number; count: number }> {
  const rows = db()
    .prepare(
      "SELECT meter_id, SUM(value) AS total, COUNT(*) AS count FROM competition_metrics WHERE competition_id = ? GROUP BY meter_id",
    )
    .all(competitionId) as { meter_id: string; total: number; count: number }[];
  return new Map(rows.map((r) => [r.meter_id, { total: r.total, count: r.count }]));
}

/** Current standings. Participants without a score yet are omitted. */
export function getLeaderboard(competitionId: string, now = new Date()): LeaderboardEntry[] {
  const c = getCompetition(competitionId);
  if (!c) return [];
  const participants = listParticipants(competitionId);
  const totals = c.type === "efficiency" ? undefined : metricTotals(competitionId);
  const scored: Omit<LeaderboardEntry, "rank">[] = [];

  for (const p of participants) {
    if (c.type === "efficiency") {
      const detail = scoreEfficiency(c, p.meter_id, now);
      if (!detail) continue;
      const { score, ...rest } = detail;
      scored.push({ meterId: p.meter_id, displayName: p.display_name, score, detail: rest });
    } else {
      const t = totals!.get(p.meter_id);
      if (!t) continue;
      scored.push({ meterId: p.meter_id, displayName: p.display_name, score: round2(t.total), detail: { entries: t.count } });
    }
  }

  // Ties share the earlier join time as the tie-breaker (first to join ranks higher).
  const joinOrder = new Map(participants.map((p, i) => [p.meter_id, i]));
  scored.sort((a, b) => b.score - a.score || joinOrder.get(a.meterId)! - joinOrder.get(b.meterId)!);
  return scored.map((e, i) => ({ rank: i + 1, ...e }));
}

// ── Participation metrics ────────────────────────────────────────────────────

export type ParticipationMetrics = {
  competitionId: string;
  participants: number;
  scoredParticipants: number;
  metricEntries: number;
  joinsByDay: { date: string; joins: number }[];
};

export function getParticipationMetrics(competitionId: string): ParticipationMetrics {
  const participants = listParticipants(competitionId).length;
  const metricEntries = (
    db().prepare("SELECT COUNT(*) AS n FROM competition_metrics WHERE competition_id = ?").get(competitionId) as { n: number }
  ).n;
  const joinsByDay = db()
    .prepare(
      `SELECT substr(joined_at, 1, 10) AS date, COUNT(*) AS joins FROM competition_participants
       WHERE competition_id = ? GROUP BY date ORDER BY date`,
    )
    .all(competitionId) as { date: string; joins: number }[];
  return {
    competitionId,
    participants,
    scoredParticipants: getLeaderboard(competitionId).length,
    metricEntries,
    joinsByDay,
  };
}

export type ParticipationSummary = {
  competitions: number;
  byStatus: Record<string, number>;
  totalEntries: number;
  uniqueParticipants: number;
  avgParticipantsPerCompetition: number;
  repeatParticipants: number;
  prizesPaid: number;
  prizesPaidAmount: number;
};

export function getParticipationSummary(): ParticipationSummary {
  const d = db();
  const byStatusRows = d.prepare("SELECT status, COUNT(*) AS n FROM competitions GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  const competitions = byStatusRows.reduce((a, r) => a + r.n, 0);
  const totalEntries = (d.prepare("SELECT COUNT(*) AS n FROM competition_participants").get() as { n: number }).n;
  const uniqueParticipants = (
    d.prepare("SELECT COUNT(DISTINCT meter_id) AS n FROM competition_participants").get() as { n: number }
  ).n;
  const repeatParticipants = (
    d
      .prepare(
        "SELECT COUNT(*) AS n FROM (SELECT meter_id FROM competition_participants GROUP BY meter_id HAVING COUNT(*) > 1)",
      )
      .get() as { n: number }
  ).n;
  const prizes = d
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM competition_prizes WHERE status = 'paid'")
    .get() as { n: number; amount: number };
  return {
    competitions,
    byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, r.n])),
    totalEntries,
    uniqueParticipants,
    avgParticipantsPerCompetition: competitions ? round2(totalEntries / competitions) : 0,
    repeatParticipants,
    prizesPaid: prizes.n,
    prizesPaidAmount: prizes.amount,
  };
}

// ── Finalisation & prizes ────────────────────────────────────────────────────

export function listPrizes(competitionId: string): Prize[] {
  return db()
    .prepare("SELECT * FROM competition_prizes WHERE competition_id = ? ORDER BY rank")
    .all(competitionId) as Prize[];
}

/** Sends `amount` stroops of XLM to `destination`; returns the tx hash. Replaceable for tests. */
export type PrizePayer = (destination: string, amountStroops: number, memo: string) => Promise<string>;

let payer: PrizePayer = async (destination, amountStroops, memo) => {
  const StellarSdk = await import("@stellar/stellar-sdk");
  const { stellarService, HORIZON_URL } = await import("./stellar.js");
  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const source = await horizon.loadAccount(stellarService.adminKeypair.publicKey());
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: stellarService.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: (amountStroops / STROOPS_PER_XLM).toFixed(7),
      }),
    )
    .addMemo(StellarSdk.Memo.text(memo.slice(0, 28)))
    .setTimeout(60)
    .build();
  tx.sign(stellarService.adminKeypair);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
};

export function setPrizePayer(fn: PrizePayer): void {
  payer = fn;
}

function payoutsEnabled(): boolean {
  return process.env.COMPETITION_PAYOUTS_ENABLED === "true";
}

/**
 * Pay every pending/failed prize. A prize is moved to "processing" before
 * the payment is submitted; if the process dies mid-payment it stays there
 * for manual review rather than being retried, so a winner is never paid twice.
 */
export async function distributePrizes(competitionId: string): Promise<Prize[]> {
  if (!payoutsEnabled()) return listPrizes(competitionId);
  const due = db()
    .prepare("SELECT * FROM competition_prizes WHERE competition_id = ? AND status IN ('pending','failed') ORDER BY rank")
    .all(competitionId) as Prize[];
  for (const prize of due) {
    const claimed = db()
      .prepare(
        "UPDATE competition_prizes SET status = 'processing' WHERE competition_id = ? AND rank = ? AND status IN ('pending','failed')",
      )
      .run(competitionId, prize.rank).changes;
    if (!claimed) continue;
    try {
      const hash = await payer(prize.stellar_address, prize.amount, `SG prize ${competitionId.slice(0, 8)} #${prize.rank}`);
      db()
        .prepare("UPDATE competition_prizes SET status = 'paid', tx_hash = ?, error = NULL, paid_at = ? WHERE competition_id = ? AND rank = ?")
        .run(hash, new Date().toISOString(), competitionId, prize.rank);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db()
        .prepare("UPDATE competition_prizes SET status = 'failed', error = ? WHERE competition_id = ? AND rank = ?")
        .run(message, competitionId, prize.rank);
      logger.error("Competition prize payout failed", { competitionId, rank: prize.rank, error: message });
    }
  }
  notify(competitionId);
  return listPrizes(competitionId);
}

/** Close a competition: freeze the leaderboard and create prize awards. */
export async function finalizeCompetition(id: string, now = new Date()): Promise<Competition | undefined> {
  const c = getCompetition(id);
  if (!c || c.status === "completed" || c.status === "cancelled") return c;

  const board = getLeaderboard(id, now);
  const participants = new Map(listParticipants(id).map((p) => [p.meter_id, p]));
  const finalize = db().transaction(() => {
    if (board.length < c.rules.minParticipants) {
      db().prepare("UPDATE competitions SET status = 'cancelled', finalized_at = ? WHERE id = ?").run(now.toISOString(), id);
      return;
    }
    const insert = db().prepare(
      `INSERT OR IGNORE INTO competition_prizes (competition_id, rank, meter_id, stellar_address, amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    c.rules.prizes.forEach((amount, i) => {
      const winner = board[i];
      if (!winner || amount <= 0) return;
      insert.run(id, winner.rank, winner.meterId, participants.get(winner.meterId)!.stellar_address, amount, now.toISOString());
    });
    db().prepare("UPDATE competitions SET status = 'completed', finalized_at = ? WHERE id = ?").run(now.toISOString(), id);
  });
  finalize();
  logger.info("Competition finalized", { id, participants: board.length });
  await distributePrizes(id);
  return getCompetition(id);
}

// ── Scheduler ────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<CompetitionType, string> = {
  efficiency: "Efficiency Challenge",
  trading: "Trading Championship",
  green_energy: "Green Energy Cup",
};

export function monthlyTypes(): CompetitionType[] {
  const raw = process.env.COMPETITION_MONTHLY_TYPES;
  if (raw === undefined) return [...COMPETITION_TYPES];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is CompetitionType => (COMPETITION_TYPES as readonly string[]).includes(t));
}

/** Create this month's competitions (idempotent via schedule_key). */
export function ensureMonthlyCompetitions(now = new Date()): Competition[] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = start.toISOString().slice(0, 7);
  const label = start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const created: Competition[] = [];
  for (const type of monthlyTypes()) {
    const key = `monthly:${type}:${month}`;
    if (db().prepare("SELECT 1 FROM competitions WHERE schedule_key = ?").get(key)) continue;
    created.push(createCompetition({ name: `${label} ${TYPE_LABEL[type]}`, type, startsAt: start, endsAt: end, scheduleKey: key, now }));
  }
  return created;
}

let tickRunning = false;

export async function competitionTick(now = new Date()): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    ensureMonthlyCompetitions(now);
    const iso = now.toISOString();
    for (const row of db()
      .prepare("SELECT id FROM competitions WHERE status = 'scheduled' AND starts_at <= ?")
      .all(iso) as { id: string }[]) {
      db().prepare("UPDATE competitions SET status = 'active' WHERE id = ?").run(row.id);
      notify(row.id);
    }
    for (const row of db()
      .prepare("SELECT id FROM competitions WHERE status = 'active' AND ends_at <= ?")
      .all(iso) as { id: string }[]) {
      await finalizeCompetition(row.id, now);
    }
    // Retry prizes that failed on a previous tick.
    for (const row of db()
      .prepare("SELECT DISTINCT competition_id AS id FROM competition_prizes WHERE status IN ('pending','failed')")
      .all() as { id: string }[]) {
      await distributePrizes(row.id);
    }
  } catch (err) {
    logger.error("Competition scheduler tick failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    tickRunning = false;
  }
}

let schedulerTimer: NodeJS.Timeout | undefined;

export function startCompetitionScheduler(): void {
  if (schedulerTimer || process.env.COMPETITIONS_ENABLED === "false") return;
  void competitionTick();
  schedulerTimer = setInterval(() => void competitionTick(), SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
}

export function stopCompetitionScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}
