/**
 * Meter device shadow endpoints (#1081). See backend/SHADOWS.md.
 *
 *   GET   /api/shadows/:meterId           — desired, reported, delta and online status
 *   PATCH /api/shadows/:meterId/desired   — update desired state
 *   PATCH /api/shadows/:meterId/reported  — device reports state (?strategy=desired_wins|reported_wins|latest_wins)
 *   POST  /api/shadows/:meterId/sync      — meter came online; returns delta to apply
 *   POST  /api/shadows/:meterId/offline   — mark meter offline
 *   GET   /api/shadows/:meterId/history   — state change history (newest first)
 */
import { Router } from "express";
import {
  delta,
  getHistory,
  getShadow,
  markOffline,
  syncOnConnect,
  updateDesired,
  updateReported,
  type ConflictStrategy,
} from "../lib/shadows.js";

const STRATEGIES = new Set<ConflictStrategy>(["desired_wins", "reported_wins", "latest_wins"]);

function isPatch(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0;
}

export const shadowsRouter = Router();

shadowsRouter.get("/:meterId", (req, res) => {
  const s = getShadow(req.params.meterId);
  res.json({ meterId: s.meterId, desired: s.desired, reported: s.reported, delta: delta(s.meterId), version: s.version, online: s.online, lastSeenAt: s.lastSeenAt });
});

shadowsRouter.patch("/:meterId/desired", (req, res) => {
  if (!isPatch(req.body)) return res.status(400).json({ error: "body must be a non-empty object" });
  res.json(updateDesired(req.params.meterId, req.body));
});

shadowsRouter.patch("/:meterId/reported", (req, res) => {
  if (!isPatch(req.body)) return res.status(400).json({ error: "body must be a non-empty object" });
  const strategy = (req.query.strategy as ConflictStrategy | undefined) ?? "desired_wins";
  if (!STRATEGIES.has(strategy)) return res.status(400).json({ error: `strategy must be one of ${[...STRATEGIES].join(", ")}` });
  res.json(updateReported(req.params.meterId, req.body, strategy));
});

shadowsRouter.post("/:meterId/sync", (req, res) => res.json(syncOnConnect(req.params.meterId)));

shadowsRouter.post("/:meterId/offline", (req, res) => {
  markOffline(req.params.meterId);
  res.json({ meterId: req.params.meterId, online: false });
});

shadowsRouter.get("/:meterId/history", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  res.json({ meterId: req.params.meterId, history: getHistory(req.params.meterId, limit) });
});
