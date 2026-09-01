/**
 * Admin audit log query and export endpoints.
 *
 * Closes #744 — energy providers need exportable audit logs for regulatory
 * compliance and dispute resolution.
 *
 * Routes:
 *   GET /api/admin/audit-logs
 *     Query the audit log with optional filters (start, end, eventType)
 *     and pagination (limit, offset).
 *
 *   GET /api/admin/audit-logs/export?format=csv|json
 *     Download the full (or filtered) audit log as CSV or JSON.
 *
 * All routes require the X-Admin-Key header (requireAdminKey middleware).
 *
 * ⚠️  WARNING: This file is implementation-only. No tests are included in
 *     this PR (closes #744). Tests should be added in a follow-up.
 */

import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  queryAuditLog,
  auditEntriesToCsv,
  type AuditQueryOptions,
} from "../lib/audit.js";

export const auditLogsRouter = Router();

/**
 * GET /api/admin/audit-logs
 *
 * Query audit log entries with optional filters.
 *
 * Query params:
 *   start        ISO-8601 date — inclusive lower bound (e.g. 2025-01-01)
 *   end          ISO-8601 date — inclusive upper bound (e.g. 2025-12-31)
 *   eventType    Path substring filter (e.g. /api/meters)
 *   limit        Max entries returned (default 500, max 1000)
 *   offset       Entries to skip for pagination (default 0)
 *
 * Response: { entries: AuditEntry[], total: number, limit: number, offset: number }
 */
auditLogsRouter.get(
  "/",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const {
      start,
      end,
      eventType,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(1000, Math.max(1, Number(rawLimit ?? 500) || 500));
    const offset = Math.max(0, Number(rawOffset ?? 0) || 0);

    if (start && isNaN(new Date(start).getTime())) {
      return res.status(400).json({ error: "Invalid start date", code: "VALIDATION_ERROR" });
    }
    if (end && isNaN(new Date(end).getTime())) {
      return res.status(400).json({ error: "Invalid end date", code: "VALIDATION_ERROR" });
    }

    const opts: AuditQueryOptions = { start, end, eventType, limit, offset };
    const { entries, total } = await queryAuditLog(opts);

    return res.json({ entries, total, limit, offset });
  }),
);

/**
 * GET /api/admin/audit-logs/export?format=csv|json
 *
 * Download the full (or date-filtered) audit log.
 *
 * Query params:
 *   format    "csv" (default) or "json"
 *   start     ISO-8601 lower bound
 *   end       ISO-8601 upper bound
 *   eventType Path substring filter
 */
auditLogsRouter.get(
  "/export",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const {
      format = "csv",
      start,
      end,
      eventType,
    } = req.query as Record<string, string | undefined>;

    if (format !== "csv" && format !== "json") {
      return res.status(400).json({
        error: "format must be 'csv' or 'json'",
        code: "VALIDATION_ERROR",
      });
    }

    if (start && isNaN(new Date(start).getTime())) {
      return res.status(400).json({ error: "Invalid start date", code: "VALIDATION_ERROR" });
    }
    if (end && isNaN(new Date(end).getTime())) {
      return res.status(400).json({ error: "Invalid end date", code: "VALIDATION_ERROR" });
    }

    // Fetch all matching entries without a result cap for a bulk export.
    const { entries } = await queryAuditLog({
      start,
      end,
      eventType,
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });

    if (format === "json") {
      res.setHeader("Content-Disposition", "attachment; filename=audit-log.json");
      res.setHeader("Content-Type", "application/json");
      return res.json(entries);
    }

    // CSV export
    const csv = auditEntriesToCsv(entries);
    res.setHeader("Content-Disposition", "attachment; filename=audit-log.csv");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.send(csv);
  }),
);
