/**
 * Meter health endpoints (#834).
 *
 *   GET  /api/meters/health                  — dashboard: every meter + status summary
 *   GET  /api/meters/:meterId/health         — health of one meter
 *   POST /api/meters/:meterId/heartbeat      — HTTP heartbeat (alternative to MQTT)
 *
 * Meter remote diagnostics (#993).
 *
 *   POST /api/meters/:meterId/diagnostics        — trigger a diagnostic command
 *   GET  /api/meters/:meterId/diagnostic-logs    — recent diagnostic results + suggested fixes
 */
import { Router } from "express";
import { getAllMeterHealth, getMeterHealth, recordHeartbeat } from "../lib/meterHealth.js";
import {
  DIAGNOSTIC_COMMANDS,
  getDiagnosticLogs,
  triggerDiagnostic,
  type DiagnosticCommand,
} from "../lib/meterDiagnostics.js";
import { getMeter } from "../lib/meters.js";
import { requireAdmin } from "../middleware/auth.js";

export const meterHealthRouter = Router();

meterHealthRouter.get("/health", (_req, res) => {
  res.json(getAllMeterHealth());
});

meterHealthRouter.get("/:meterId/health", (req, res) => {
  const health = getMeterHealth(req.params.meterId);
  if (!health) {
    return res.status(404).json({ error: "No heartbeat recorded for this meter" });
  }
  res.json(health);
});

meterHealthRouter.post("/:meterId/heartbeat", (req, res) => {
  const { responseTimeMs, error } = req.body ?? {};
  recordHeartbeat(req.params.meterId, {
    responseTimeMs: typeof responseTimeMs === "number" ? responseTimeMs : undefined,
    error: error === true,
  });
  res.status(202).json(getMeterHealth(req.params.meterId));
});

meterHealthRouter.post("/:meterId/diagnostics", requireAdmin, (req, res) => {
  const { meterId } = req.params;
  const { command } = req.body ?? {};

  if (typeof command !== "string" || !DIAGNOSTIC_COMMANDS.includes(command as DiagnosticCommand)) {
    return res.status(400).json({
      error: `Invalid command. Must be one of: ${DIAGNOSTIC_COMMANDS.join(", ")}`,
    });
  }

  if (!getMeter(meterId)) {
    return res.status(404).json({ error: "Meter not found" });
  }

  const result = triggerDiagnostic(meterId, command as DiagnosticCommand);
  res.status(202).json(result);
});

meterHealthRouter.get("/:meterId/diagnostic-logs", requireAdmin, (req, res) => {
  const { meterId } = req.params;

  if (!getMeter(meterId)) {
    return res.status(404).json({ error: "Meter not found" });
  }

  const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const offset = Number.parseInt(String(req.query.offset ?? ""), 10);

  res.json(
    getDiagnosticLogs(meterId, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      offset: Number.isFinite(offset) && offset >= 0 ? offset : undefined,
    }),
  );
});