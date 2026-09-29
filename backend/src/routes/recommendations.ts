/**
 * Energy recommendations API (#895)
 *
 * GET  /api/recommendations/:meterId              — this week's recommendations (generated on demand)
 * POST /api/recommendations/:meterId/:id/accept   — accept a suggestion
 * POST /api/recommendations/:meterId/:id/dismiss  — dismiss a suggestion
 * GET  /api/recommendations/:meterId/savings      — estimated vs actual savings
 * POST /api/recommendations/:meterId/subscribe    — { ownerAddress } weekly push notifications
 */
import { Router } from "express";
import {
  generateWeekly,
  respond,
  savingsSummary,
  subscribe,
} from "../lib/recommendations.js";

export const recommendationsRouter = Router();

recommendationsRouter.get("/:meterId", (req, res) => {
  res.json({ recommendations: generateWeekly(req.params.meterId) });
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
