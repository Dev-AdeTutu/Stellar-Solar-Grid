import { describe, it, expect, beforeEach } from "vitest";
import {
  createChallenge,
  finalizeChallenge,
  finalizeExpired,
  getLeaderboard,
  getProgress,
  joinChallenge,
  recordUsage,
  resetChallenges,
} from "../src/lib/challenges.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const ADDR = (c: string) => "G" + c.repeat(55);

function weekChallenge(prizes = [100, 50]) {
  return createChallenge(
    { name: "Cut peak 20% this week", metric: "peak_reduction", targetPct: 20, startsAt: T0, endsAt: T0 + 7 * DAY, prizes },
    T0,
  );
}

describe("energy challenges (#1059)", () => {
  beforeEach(() => resetChallenges());

  it("validates challenge input", () => {
    expect(() =>
      createChallenge({ name: "x", metric: "peak_reduction", targetPct: 0, startsAt: T0, endsAt: T0 + DAY, prizes: [] }, T0),
    ).toThrow(/targetPct/);
    expect(() =>
      createChallenge({ name: "x", metric: "peak_reduction", targetPct: 20, startsAt: T0, endsAt: T0, prizes: [] }, T0),
    ).toThrow(/endsAt/);
  });

  it("tracks participation and ranks by peak reduction", () => {
    const c = weekChallenge();
    joinChallenge(c.id, { meterId: "A", stellarAddress: ADDR("A"), baseline: 10 }, T0);
    joinChallenge(c.id, { meterId: "B", stellarAddress: ADDR("B"), baseline: 10 }, T0);
    expect(() => joinChallenge(c.id, { meterId: "A", stellarAddress: ADDR("A"), baseline: 10 }, T0)).toThrow(/already/);

    recordUsage(c.id, "A", 7, T0 + DAY); // 30% peak reduction
    recordUsage(c.id, "B", 9, T0 + DAY); // 10%
    const board = getLeaderboard(c.id, T0 + DAY);
    expect(board.map((e) => [e.meterId, e.reductionPct, e.targetMet])).toEqual([
      ["A", 30, true],
      ["B", 10, false],
    ]);
    expect(getProgress(c.id, "B", T0 + DAY).progressPct).toBe(50);
  });

  it("supports total-usage challenges", () => {
    const c = createChallenge(
      { name: "Total", metric: "total_reduction", targetPct: 10, startsAt: T0, endsAt: T0 + DAY, prizes: [] },
      T0,
    );
    joinChallenge(c.id, { meterId: "A", stellarAddress: ADDR("A"), baseline: 100 }, T0);
    recordUsage(c.id, "A", 40, T0 + 1);
    recordUsage(c.id, "A", 40, T0 + 2);
    expect(getLeaderboard(c.id, T0 + 3)[0].reductionPct).toBe(20);
  });

  it("rejects usage outside the active window", () => {
    const c = weekChallenge();
    joinChallenge(c.id, { meterId: "A", stellarAddress: ADDR("A"), baseline: 10 }, T0 - 1);
    expect(() => recordUsage(c.id, "A", 5, T0 - 1)).toThrow(/not active/);
  });

  it("pays prizes only to winners that met the target, once", async () => {
    const c = weekChallenge();
    for (const [m, peak] of [["A", 7], ["B", 8], ["C", 9.5]] as const) {
      joinChallenge(c.id, { meterId: m, stellarAddress: ADDR(m), baseline: 10 }, T0);
      recordUsage(c.id, m, peak, T0 + DAY);
    }
    const paid: [string, number][] = [];
    const pay = async (to: string, amt: number) => void paid.push([to, amt]);
    const awards = await finalizeChallenge(c.id, pay, T0 + 2 * DAY);
    expect(awards.map((a) => [a.meterId, a.rank, a.amount, a.status])).toEqual([
      ["A", 1, 100, "paid"],
      ["B", 2, 50, "paid"],
    ]);
    await finalizeChallenge(c.id, pay, T0 + 3 * DAY);
    expect(paid).toHaveLength(2);
  });

  it("records failed payouts and auto-finalizes expired challenges", async () => {
    const c = weekChallenge([10]);
    joinChallenge(c.id, { meterId: "A", stellarAddress: ADDR("A"), baseline: 10 }, T0);
    recordUsage(c.id, "A", 5, T0 + DAY);
    const pay = async () => {
      throw new Error("horizon down");
    };
    expect(await finalizeExpired(pay, T0 + DAY)).toEqual([]);
    expect(await finalizeExpired(pay, T0 + 7 * DAY)).toEqual([c.id]);
    const [award] = await finalizeChallenge(c.id, pay, T0 + 8 * DAY);
    expect(award.status).toBe("failed");
    expect(award.error).toBe("horizon down");
  });
});
