/**
 * Gamified energy challenges (#1059).
 *
 * Public:
 *   GET  /api/challenges                              — list challenges
 *   GET  /api/challenges/:id                          — details
 *   GET  /api/challenges/:id/leaderboard              — standings
 *   GET  /api/challenges/:id/progress/:meterId        — a participant's progress
 *   GET  /api/challenges/:id/prizes                   — prize awards
 *   POST /api/challenges/:id/join                     — { meterId, stellarAddress, baseline }
 *   POST /api/challenges/:id/usage                    — { meterId, kwh }
 *
 * Admin (X-Admin-Key):
 *   POST /api/challenges                              — create { name, metric, targetPct, startsAt, endsAt, prizes }
 *   POST /api/challenges/:id/finalize                 — close and distribute prizes
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  createChallenge,
  finalizeChallenge,
  finalizeExpired,
  getAwards,
  getChallenge,
  getLeaderboard,
  getProgress,
  joinChallenge,
  listChallenges,
  recordUsage,
  type PrizePayer,
} from "../lib/challenges.js";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** Default payer logs the payout; production wires this to the treasury payment service. */
const logPayer: PrizePayer = async (to, amount) => {
  console.log(`[challenges] prize payout ${amount} XLM -> ${to}`);
};

export function createChallengesRouter(pay: PrizePayer = logPayer): Router {
  const router = Router();

  const fail = (res: import("express").Response, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(msg.includes("not found") ? 404 : 400).json({ error: msg });
  };

  router.get("/", (_req, res) => {
    res.json({ challenges: listChallenges() });
  });

  router.post("/", requireAdminKey, (req, res) => {
    const { name, metric, targetPct, startsAt, endsAt, prizes } = req.body ?? {};
    try {
      res.status(201).json(
        createChallenge({
          name,
          metric,
          targetPct: Number(targetPct),
          startsAt: new Date(startsAt).getTime(),
          endsAt: new Date(endsAt).getTime(),
          prizes: Array.isArray(prizes) ? prizes.map(Number) : [],
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/:id", (req, res) => {
    const c = getChallenge(req.params.id);
    if (!c) return res.status(404).json({ error: "challenge not found" });
    res.json(c);
  });

  router.get("/:id/leaderboard", (req, res) => {
    try {
      res.json({ leaderboard: getLeaderboard(req.params.id) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/:id/progress/:meterId", (req, res) => {
    try {
      res.json(getProgress(req.params.id, req.params.meterId));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/:id/prizes", (req, res) => {
    res.json({ prizes: getAwards(req.params.id) });
  });

  router.post("/:id/join", (req, res) => {
    const { meterId, stellarAddress, baseline } = req.body ?? {};
    if (typeof meterId !== "string" || !meterId) return res.status(400).json({ error: "meterId is required" });
    if (typeof stellarAddress !== "string" || !STELLAR_ADDRESS_RE.test(stellarAddress)) {
      return res.status(400).json({ error: "invalid stellarAddress" });
    }
    try {
      res.status(201).json(joinChallenge(req.params.id, { meterId, stellarAddress, baseline: Number(baseline) }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/:id/usage", (req, res) => {
    const { meterId, kwh } = req.body ?? {};
    try {
      recordUsage(req.params.id, String(meterId), Number(kwh));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.post(
    "/:id/finalize",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      try {
        res.json({ prizes: await finalizeChallenge(req.params.id, pay) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  return router;
}

/** Periodically close expired challenges and pay out prizes automatically. */
export function startChallengeScheduler(pay: PrizePayer = logPayer, intervalMs = 60_000): NodeJS.Timeout {
  const t = setInterval(() => {
    finalizeExpired(pay).catch((err) => console.error("[challenges] finalize failed", err));
  }, intervalMs);
  t.unref();
  return t;
}

export const challengesRouter = createChallengesRouter();
