import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  generateTheftMonthlyReport,
  getTheftInvestigationHistory,
  listTheftAlerts,
  updateTheftInvestigation,
  type TheftAlertStatus,
} from "../lib/theftDetection.js";

export const theftDetectionRouter = Router();
const STATUSES: TheftAlertStatus[] = ["open", "investigating", "resolved", "false_positive"];

theftDetectionRouter.use(requireAdminKey);

theftDetectionRouter.get("/alerts", (req, res) => {
  const status = req.query.status as TheftAlertStatus | undefined;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: "invalid status" });
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: "limit and offset must be valid non-negative integers" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(listTheftAlerts({ status, limit, offset }));
});

theftDetectionRouter.get("/alerts/:id/investigation", (req, res) => {
  const alertId = Number(req.params.id);
  if (!Number.isSafeInteger(alertId) || alertId < 1) return res.status(400).json({ error: "invalid alert id" });
  res.json({ events: getTheftInvestigationHistory(alertId) });
});

theftDetectionRouter.patch("/alerts/:id/investigation", (req, res) => {
  const alertId = Number(req.params.id);
  const { status, actor, assignedTo, note } = req.body ?? {};
  if (!Number.isSafeInteger(alertId) || alertId < 1) return res.status(400).json({ error: "invalid alert id" });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
  if (actor !== undefined && (typeof actor !== "string" || actor.length > 100)) return res.status(400).json({ error: "actor must be at most 100 characters" });
  if (assignedTo !== undefined && assignedTo !== null && (typeof assignedTo !== "string" || assignedTo.length > 100)) {
    return res.status(400).json({ error: "assignedTo must be a string or null" });
  }
  if (note !== undefined && (typeof note !== "string" || note.length > 2000)) return res.status(400).json({ error: "note must be at most 2000 characters" });
  const alert = updateTheftInvestigation({
    alertId,
    status,
    actor: typeof actor === "string" && actor.trim() ? actor.trim() : "admin",
    assignedTo,
    note,
  });
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  res.json({ alert });
});

theftDetectionRouter.get("/reports/monthly", (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : new Date().toISOString().slice(0, 7);
  const report = generateTheftMonthlyReport(month);
  if (!report) return res.status(400).json({ error: "month must be YYYY-MM" });
  res.json(report);
});