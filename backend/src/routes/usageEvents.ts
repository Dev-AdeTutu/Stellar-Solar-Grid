import { Router } from "express";
import { adminAuth } from "../lib/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  purgeSubmittedUsageEvents,
  getFailedUsageEvents,
  replayFailedUsageEvent,
  compactUsageEvents,
  getUsageSummary,
} from "../lib/usageEvents.js";

export const usageEventsRouter = Router();

// Apply adminAuth middleware to all routes in this router
usageEventsRouter.use(adminAuth);

/**
 * DELETE /api/usage-events
 * Purge submitted usage events older than N days (default 90)
 */
usageEventsRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    const olderThanDaysQuery = req.query.olderThanDays;
    let olderThanDays = 90;
    if (olderThanDaysQuery !== undefined) {
      const parsed = parseInt(String(olderThanDaysQuery), 10);
      if (isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ error: "Invalid olderThanDays parameter", code: "VALIDATION_ERROR" });
      }
      olderThanDays = parsed;
    }

    const deletedCount = purgeSubmittedUsageEvents(olderThanDays);
    return res.json({ deletedCount });
  })
);

/**
 * POST /api/usage-events/compact
 *
 * Manually trigger the retention/compaction job (Closes #685): rolls
 * 'submitted' events older than the detail retention window (default 90
 * days) into daily usage_summary rows, archives events older than the
 * archive retention window (default 365 days) to a gzipped JSONL file, then
 * deletes the compacted detail rows and reclaims space with VACUUM. Runs
 * automatically once a day at 02:00 UTC; this endpoint is for ops to run it
 * on demand (e.g. right after lowering the retention window).
 */
usageEventsRouter.post(
  "/compact",
  asyncHandler(async (req, res) => {
    const detailedRetentionDays = req.body?.detailedRetentionDays;
    const archiveRetentionDays = req.body?.archiveRetentionDays;
    if (detailedRetentionDays !== undefined && (typeof detailedRetentionDays !== "number" || detailedRetentionDays < 0)) {
      return res.status(400).json({ error: "Invalid detailedRetentionDays parameter", code: "VALIDATION_ERROR" });
    }
    if (archiveRetentionDays !== undefined && (typeof archiveRetentionDays !== "number" || archiveRetentionDays < 0)) {
      return res.status(400).json({ error: "Invalid archiveRetentionDays parameter", code: "VALIDATION_ERROR" });
    }

    const result = compactUsageEvents({ detailedRetentionDays, archiveRetentionDays });
    return res.json(result);
  })
);

/**
 * GET /api/usage-events/summary?meterId=&limit=
 *
 * Aggregated daily usage from usage_summary (populated by the compaction
 * job), most recent day first. Covers history older than the detail
 * retention window without needing the raw per-event rows.
 */
usageEventsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const meterId = typeof req.query.meterId === "string" ? req.query.meterId : undefined;
    const limit = Math.min(365, Math.max(1, parseInt(String(req.query.limit ?? "90"), 10) || 90));

    const summary = getUsageSummary(meterId, limit);
    return res.json({ summary, count: summary.length });
  })
);

/**
 * GET /api/usage-events/failed
 * List all dead-lettered events (status = 'failed') with pagination
 */
usageEventsRouter.get(
  "/failed",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "10"), 10)));

    const result = getFailedUsageEvents(page, pageSize);
    return res.json({
      events: result.events,
      pagination: {
        page,
        pageSize,
        total: result.total,
        pages: Math.ceil(result.total / pageSize),
      },
    });
  })
);

/**
 * POST /api/usage-events/:id/replay
 * Replay a failed usage event by setting status to 'pending' and attempt_count to 0
 */
usageEventsRouter.post(
  "/:id/replay",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid event ID", code: "VALIDATION_ERROR" });
    }

    const updatedEvent = replayFailedUsageEvent(id);
    if (!updatedEvent) {
      return res.status(404).json({ error: "Failed usage event not found", code: "NOT_FOUND" });
    }

    return res.json(updatedEvent);
  })
);
