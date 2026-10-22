/**
 * Gamified energy challenges (#1059).
 *
 * Time-limited challenges (e.g. "reduce peak usage 20% this week") that track
 * each participant's performance against their own baseline, rank them on a
 * per-challenge leaderboard and automatically distribute prizes on close.
 */

export type ChallengeMetric = "peak_reduction" | "total_reduction";
export type ChallengeStatus = "scheduled" | "active" | "completed" | "cancelled";

export interface Challenge {
  id: string;
  name: string;
  metric: ChallengeMetric;
  /** Target reduction in percent (e.g. 20 for "reduce by 20%"). */
  targetPct: number;
  startsAt: number;
  endsAt: number;
  /** Prize pool in XLM, split across ranks (index 0 = 1st place). */
  prizes: number[];
  status: ChallengeStatus;
}

export interface Participant {
  meterId: string;
  stellarAddress: string;
  /** Baseline usage (kWh) — peak or total depending on the metric. */
  baseline: number;
  /** Readings recorded during the challenge window (kWh). */
  readings: number[];
}

export interface LeaderboardEntry {
  rank: number;
  meterId: string;
  reductionPct: number;
  targetMet: boolean;
}

export interface PrizeAward {
  challengeId: string;
  meterId: string;
  stellarAddress: string;
  rank: number;
  amount: number;
  status: "paid" | "failed";
  error?: string;
}

export type PrizePayer = (to: string, amount: number) => Promise<void>;

const challenges = new Map<string, Challenge>();
const participants = new Map<string, Map<string, Participant>>();
const awards = new Map<string, PrizeAward[]>();
let seq = 0;

export function resetChallenges(): void {
  challenges.clear();
  participants.clear();
  awards.clear();
  seq = 0;
}

function statusAt(c: Challenge, now: number): ChallengeStatus {
  if (c.status === "completed" || c.status === "cancelled") return c.status;
  return now < c.startsAt ? "scheduled" : "active";
}

export function createChallenge(
  input: Omit<Challenge, "id" | "status">,
  now = Date.now(),
): Challenge {
  if (!input.name?.trim()) throw new Error("name is required");
  if (!["peak_reduction", "total_reduction"].includes(input.metric)) throw new Error("invalid metric");
  if (!(input.targetPct > 0 && input.targetPct <= 100)) throw new Error("targetPct must be in (0, 100]");
  if (!(input.endsAt > input.startsAt)) throw new Error("endsAt must be after startsAt");
  if (!Array.isArray(input.prizes) || input.prizes.some((p) => !(p >= 0))) throw new Error("invalid prizes");
  const c: Challenge = { ...input, id: `ch_${++seq}`, status: "scheduled" };
  c.status = statusAt(c, now);
  challenges.set(c.id, c);
  participants.set(c.id, new Map());
  return c;
}

export function getChallenge(id: string, now = Date.now()): Challenge | undefined {
  const c = challenges.get(id);
  if (c) c.status = statusAt(c, now);
  return c;
}

export function listChallenges(now = Date.now()): Challenge[] {
  return [...challenges.keys()].map((id) => getChallenge(id, now)!);
}

export function joinChallenge(
  id: string,
  p: { meterId: string; stellarAddress: string; baseline: number },
  now = Date.now(),
): Participant {
  const c = getChallenge(id, now);
  if (!c) throw new Error("challenge not found");
  if (c.status === "completed" || c.status === "cancelled") throw new Error("challenge is closed");
  if (!(p.baseline > 0)) throw new Error("baseline must be positive");
  const map = participants.get(id)!;
  if (map.has(p.meterId)) throw new Error("already joined");
  const entry: Participant = { ...p, readings: [] };
  map.set(p.meterId, entry);
  return entry;
}

export function recordUsage(id: string, meterId: string, kwh: number, now = Date.now()): void {
  const c = getChallenge(id, now);
  if (!c) throw new Error("challenge not found");
  if (c.status !== "active") throw new Error("challenge is not active");
  if (!(kwh >= 0)) throw new Error("kwh must be non-negative");
  const p = participants.get(id)!.get(meterId);
  if (!p) throw new Error("not a participant");
  p.readings.push(kwh);
}

export function performance(c: Challenge, p: Participant): number | null {
  if (p.readings.length === 0) return null;
  const observed =
    c.metric === "peak_reduction" ? Math.max(...p.readings) : p.readings.reduce((a, b) => a + b, 0);
  return Math.round(((p.baseline - observed) / p.baseline) * 10_000) / 100;
}

export function getLeaderboard(id: string, now = Date.now()): LeaderboardEntry[] {
  const c = getChallenge(id, now);
  if (!c) throw new Error("challenge not found");
  return [...participants.get(id)!.values()]
    .map((p) => ({ meterId: p.meterId, reductionPct: performance(c, p) }))
    .filter((e): e is { meterId: string; reductionPct: number } => e.reductionPct !== null)
    .sort((a, b) => b.reductionPct - a.reductionPct || a.meterId.localeCompare(b.meterId))
    .map((e, i) => ({ ...e, rank: i + 1, targetMet: e.reductionPct >= c.targetPct }));
}

export function getProgress(id: string, meterId: string, now = Date.now()) {
  const c = getChallenge(id, now);
  if (!c) throw new Error("challenge not found");
  const p = participants.get(id)!.get(meterId);
  if (!p) throw new Error("not a participant");
  const reductionPct = performance(c, p);
  const entry = getLeaderboard(id, now).find((e) => e.meterId === meterId);
  return {
    challengeId: id,
    meterId,
    reductionPct,
    targetPct: c.targetPct,
    progressPct: reductionPct === null ? 0 : Math.max(0, Math.min(100, (reductionPct / c.targetPct) * 100)),
    rank: entry?.rank ?? null,
  };
}

/** Close a challenge and pay prizes to the top finishers who met the target. */
export async function finalizeChallenge(
  id: string,
  pay: PrizePayer,
  now = Date.now(),
): Promise<PrizeAward[]> {
  const c = getChallenge(id, now);
  if (!c) throw new Error("challenge not found");
  if (c.status === "completed") return awards.get(id) ?? [];
  if (c.status === "cancelled") throw new Error("challenge is cancelled");
  const board = getLeaderboard(id, now).filter((e) => e.targetMet);
  c.status = "completed";
  const result: PrizeAward[] = [];
  for (const [i, amount] of c.prizes.entries()) {
    const e = board[i];
    if (!e || amount <= 0) continue;
    const p = participants.get(id)!.get(e.meterId)!;
    const award: PrizeAward = {
      challengeId: id,
      meterId: e.meterId,
      stellarAddress: p.stellarAddress,
      rank: e.rank,
      amount,
      status: "paid",
    };
    try {
      await pay(p.stellarAddress, amount);
    } catch (err) {
      award.status = "failed";
      award.error = err instanceof Error ? err.message : String(err);
    }
    result.push(award);
  }
  awards.set(id, result);
  return result;
}

/** Close any challenges whose window has ended. */
export async function finalizeExpired(pay: PrizePayer, now = Date.now()): Promise<string[]> {
  const done: string[] = [];
  for (const c of listChallenges(now)) {
    if (c.status === "active" && now >= c.endsAt) {
      await finalizeChallenge(c.id, pay, now);
      done.push(c.id);
    }
  }
  return done;
}

export function getAwards(id: string): PrizeAward[] {
  return awards.get(id) ?? [];
}
