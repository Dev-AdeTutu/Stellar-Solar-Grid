import { Router } from "express";
import { adminAuth } from "../lib/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  purgeSubmittedUsageEvents,
  getFailedUsageEvents,
  replayFailedUsageEvent,
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
