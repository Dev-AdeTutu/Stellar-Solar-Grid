/**
 * Energy trading competitions (#903).
 *
 * Public:
 *   GET    /api/competitions                              — list (?status=&type=)
 *   GET    /api/competitions/metrics                      — participation summary
 *   GET    /api/competitions/:id                          — details, rules, prizes
 *   GET    /api/competitions/:id/leaderboard              — current standings
 *   GET    /api/competitions/:id/leaderboard/stream       — standings via Server-Sent Events
 *   GET    /api/competitions/:id/metrics                  — participation metrics
 *   POST   /api/competitions/:id/join                     — { meterId, stellarAddress, displayName? }
 *   DELETE /api/competitions/:id/participants/:meterId    — leave
 *
 * Admin (X-Admin-Key):
 *   POST   /api/competitions                              — create { name, type, startsAt, endsAt, rules? }
 *   PATCH  /api/competitions/:id                          — update { name?, endsAt?, rules? }
 *   POST   /api/competitions/:id/cancel
 *   POST   /api/competitions/:id/finalize                 — close now and award prizes
 *   POST   /api/competitions/:id/scores                   — { meterId, value, recordedAt? } for trading / green_energy
 *   POST   /api/competitions/:id/prizes/retry             — retry failed prize payouts
 */
import { Router, type Request } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ownsMeter } from "../lib/meterOwnership.js";
import {
  COMPETITION_TYPES,
  cancelCompetition,
  createCompetition,
  defaultRules,
  distributePrizes,
  finalizeCompetition,
  getCompetition,
  getLeaderboard,
  getParticipationMetrics,
  getParticipationSummary,
  joinCompetition,
  leaveCompetition,
  listCompetitions,
  listParticipants,
  listPrizes,
  mergeRules,
  onLeaderboardChange,
  recordMetric,
  updateCompetition,
  type CompetitionStatus,
  type CompetitionType,
} from "../lib/competitions.js";

export const competitionsRouter = Router();

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const STATUSES: CompetitionStatus[] = ["scheduled", "active", "completed", "cancelled"];
const LIVE_REFRESH_MS = Number(process.env.COMPETITION_LIVE_REFRESH_MS ?? 15_000);

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

competitionsRouter.get("/", (req, res) => {
  const status = req.query.status as CompetitionStatus | undefined;
  const type = req.query.type as CompetitionType | undefined;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: "invalid status" });
  if (type && !COMPETITION_TYPES.includes(type)) return res.status(400).json({ error: "invalid type" });
  res.json({ competitions: listCompetitions({ status, type }) });
});

competitionsRouter.get("/metrics", (_req, res) => {
  res.json(getParticipationSummary());
});

competitionsRouter.post("/", requireAdminKey, (req, res) => {
  const { name, type, startsAt, endsAt, rules } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required" });
  if (!COMPETITION_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${COMPETITION_TYPES.join(", ")}` });
  }
  const start = parseDate(startsAt);
  const end = parseDate(endsAt);
  if (!start || !end || end <= start) return res.status(400).json({ error: "startsAt/endsAt must be ISO dates with endsAt after startsAt" });
  const merged = mergeRules(defaultRules(), rules);
  if (typeof merged === "string") return res.status(400).json({ error: merged });
  res.status(201).json(createCompetition({ name: name.trim().slice(0, 120), type, startsAt: start, endsAt: end, rules: merged }));
});

function loadCompetition(req: Request) {
  return getCompetition(req.params.id);
}

competitionsRouter.get("/:id", (req, res) => {
  const c = loadCompetition(req);
  if (!c) return res.status(404).json({ error: "Competition not found" });
  res.json({ ...c, participants: listParticipants(c.id).length, prizes: listPrizes(c.id) });
});

competitionsRouter.patch("/:id", requireAdminKey, (req, res) => {
  const c = loadCompetition(req);
  if (!c) return res.status(404).json({ error: "Competition not found" });
  if (c.status === "completed" || c.status === "cancelled") {
    return res.status(409).json({ error: `Competition is ${c.status}` });
  }
  const { name, endsAt, rules } = req.body ?? {};
  const merged = mergeRules(c.rules, rules);
  if (typeof merged === "string") return res.status(400).json({ error: merged });
  let end: Date | undefined;
  if (endsAt !== undefined) {
    const parsed = parseDate(endsAt);
    if (!parsed || parsed <= new Date(c.starts_at)) return res.status(400).json({ error: "endsAt must be after startsAt" });
    end = parsed;
  }
  res.json(updateCompetition(c.id, { name: typeof name === "string" ? name.trim().slice(0, 120) : undefined, rules: merged, endsAt: end }));
});

competitionsRouter.post("/:id/cancel", requireAdminKey, (req, res) => {
  const c = cancelCompetition(req.params.id);
  if (!c) return res.status(404).json({ error: "Competition not found" });
  res.json(c);
});

competitionsRouter.post(
  "/:id/finalize",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const c = await finalizeCompetition(req.params.id);
    if (!c) return res.status(404).json({ error: "Competition not found" });
    res.json({ ...c, prizes: listPrizes(c.id) });
  }),
);

competitionsRouter.post(
  "/:id/prizes/retry",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    if (!loadCompetition(req)) return res.status(404).json({ error: "Competition not found" });
    res.json({ prizes: await distributePrizes(req.params.id) });
  }),
);

competitionsRouter.post("/:id/scores", requireAdminKey, (req, res) => {
  const { meterId, value, recordedAt } = req.body ?? {};
  if (typeof meterId !== "string" || !meterId) return res.status(400).json({ error: "meterId is required" });
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return res.status(400).json({ error: "value must be a non-negative number" });
  }
  const at = recordedAt === undefined ? new Date() : parseDate(recordedAt);
  if (!at) return res.status(400).json({ error: "recordedAt must be an ISO date" });
  const result = recordMetric(req.params.id, meterId, value, at);
  if (!result.ok) return res.status(result.error === "Competition not found" ? 404 : 409).json({ error: result.error });
  res.status(202).json({ accepted: true });
});

competitionsRouter.post(
  "/:id/join",
  asyncHandler(async (req, res) => {
    const { meterId, stellarAddress, displayName } = req.body ?? {};
    if (typeof meterId !== "string" || !meterId) return res.status(400).json({ error: "meterId is required" });
    if (typeof stellarAddress !== "string" || !STELLAR_ADDRESS_RE.test(stellarAddress)) {
      return res.status(400).json({ error: "stellarAddress must be a valid Stellar public key" });
    }
    if (!loadCompetition(req)) return res.status(404).json({ error: "Competition not found" });
    try {
      if (!(await ownsMeter(meterId, stellarAddress))) {
        return res.status(403).json({ error: "stellarAddress is not the owner of this meter" });
      }
    } catch {
      return res.status(502).json({ error: "Could not verify meter ownership", code: "CONTRACT_ERROR" });
    }
    const result = joinCompetition(req.params.id, {
      meterId,
      stellarAddress,
      displayName: typeof displayName === "string" ? displayName.trim().slice(0, 40) || null : null,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.participant);
  }),
);

competitionsRouter.delete("/:id/participants/:meterId", (req, res) => {
  if (!leaveCompetition(req.params.id, req.params.meterId)) {
    return res.status(404).json({ error: "Participant not found" });
  }
  res.status(204).end();
});

competitionsRouter.get("/:id/leaderboard", (req, res) => {
  const c = loadCompetition(req);
  if (!c) return res.status(404).json({ error: "Competition not found" });
  res.json({ competitionId: c.id, status: c.status, updatedAt: new Date().toISOString(), entries: getLeaderboard(c.id) });
});

/**
 * Pushes the leaderboard whenever it changes: immediately on joins/score
 * updates, and on a timer for efficiency competitions (which move with
 * incoming usage data). Unchanged boards are not re-sent.
 */
competitionsRouter.get("/:id/leaderboard/stream", (req, res) => {
  const c = loadCompetition(req);
  if (!c) return res.status(404).json({ error: "Competition not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let last = "";
  const push = () => {
    const current = getCompetition(c.id);
    const entries = getLeaderboard(c.id);
    const serialized = JSON.stringify({ status: current?.status, entries });
    if (serialized === last) return;
    last = serialized;
    res.write(`event: leaderboard\ndata: ${JSON.stringify({ competitionId: c.id, status: current?.status, updatedAt: new Date().toISOString(), entries })}\n\n`);
  };

  push();
  const unsubscribe = onLeaderboardChange(c.id, push);
  const refresh = setInterval(push, LIVE_REFRESH_MS);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    unsubscribe();
    clearInterval(refresh);
    clearInterval(heartbeat);
  });
});

competitionsRouter.get("/:id/metrics", (req, res) => {
  if (!loadCompetition(req)) return res.status(404).json({ error: "Competition not found" });
  res.json(getParticipationMetrics(req.params.id));
});
