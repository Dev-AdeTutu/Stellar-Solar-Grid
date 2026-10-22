/**
 * Energy recommendations API (#895)
 *
 * GET  /api/recommendations/:meterId              — this week's recommendations (generated on demand)
 * POST /api/recommendations/:meterId/:id/accept   — accept a suggestion
 * POST /api/recommendations/:meterId/:id/dismiss  — dismiss a suggestion
 * GET  /api/recommendations/:meterId/savings      — estimated vs actual savings
 * POST /api/recommendations/:meterId/subscribe    — { ownerAddress } weekly push notifications
 *
 * Behavioral economics nudges (#1066) — see backend/BEHAVIORAL.md
 *
 * GET  /api/recommendations/:meterId/nudges              — active nudges for this meter
 * POST /api/recommendations/:meterId/nudges/:id/impression — record a nudge impression
 * POST /api/recommendations/:meterId/nudges/:id/accept     — record nudge acceptance
 * POST /api/recommendations/:meterId/pledges             — { targetReductionPct, deadline } commitment device
 * GET  /api/recommendations/:meterId/pledges             — list pledges with progress
 * GET  /api/recommendations/:meterId/experiments         — A/B experiment assignments
 * GET  /api/recommendations/:meterId/experiments/metrics — A/B impact metrics
 */
import { Router } from "express";
import {
  generateWeekly,
  listRecommendations,
  respond,
  savingsSummary,
  subscribe,
} from "../lib/recommendations.js";
import {
  listNudges,
  recordImpression,
  recordAcceptance,
  createPledge,
  listPledges,
  getAssignments,
  experimentMetrics,
} from "../lib/nudges.js";

export const recommendationsRouter = Router();

recommendationsRouter.get("/:meterId", (req, res) => {
  const recommendations = listRecommendations(req.params.meterId);
  res.json({ recommendations });
});

recommendationsRouter.get("/:meterId/savings", (req, res) => {
  res.json(savingsSummary(req.params.meterId));
});

recommendationsRouter.post("/:meterId/subscribe", (req, res) => {
  const owner = req.body?.ownerAddress;
  if (typeof owner !== "string" || !/^G[A-Z2-7]{55}$/.test(owner)) {
    return res.status(400).json({ error: "Valid Stellar ownerAddress required" });
  }
  subscribe(req.params.meterId, owner);
  res.status(204).end();
});

recommendationsRouter.post("/:meterId/:id/:action(accept|dismiss)", (req, res) => {
  const updated = respond(req.params.meterId, Number(req.params.id), req.params.action as "accept" | "dismiss");
  if (!updated) return res.status(404).json({ error: "Recommendation not found" });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Behavioral economics nudges (#1066)
// ---------------------------------------------------------------------------

recommendationsRouter.get("/:meterId/nudges", (req, res) => {
  res.json({ nudges: listNudges(req.params.meterId) });
});

recommendationsRouter.post("/:meterId/nudges/:id/impression", (req, res) => {
  const result = recordImpression(req.params.meterId, req.params.id);
  if (!result) return res.status(404).json({ error: "Nudge not found" });
  res.json(result);
});

recommendationsRouter.post("/:meterId/nudges/:id/accept", (req, res) => {
  const result = recordAcceptance(req.params.meterId, req.params.id);
  if (!result) return res.status(404).json({ error: "Nudge not found" });
  res.json(result);
});

recommendationsRouter.post("/:meterId/pledges", (req, res) => {
  const { targetReductionPct, deadline } = req.body ?? {};
  if (typeof targetReductionPct !== "number" || targetReductionPct <= 0 || targetReductionPct > 100) {
    return res.status(400).json({ error: "targetReductionPct must be a number in (0, 100]" });
  }
  if (typeof deadline !== "string" || Number.isNaN(Date.parse(deadline))) {
    return res.status(400).json({ error: "Valid ISO deadline required" });
  }
  const pledge = createPledge(req.params.meterId, targetReductionPct, deadline);
  res.status(201).json(pledge);
});

recommendationsRouter.get("/:meterId/pledges", (req, res) => {
  res.json({ pledges: listPledges(req.params.meterId) });
});

recommendationsRouter.get("/:meterId/experiments", (req, res) => {
  res.json({ assignments: getAssignments(req.params.meterId) });
});

recommendationsRouter.get("/:meterId/experiments/metrics", (req, res) => {
  res.json(experimentMetrics(req.params.meterId));
});
