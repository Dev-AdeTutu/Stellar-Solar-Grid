import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  getDeadLetterEvents,
  requeueDeadLetterEvent,
} from "../lib/usageEvents.js";

export const deadLettersRouter = Router();

/**
 * GET /api/admin/dead-letters
 *
 * Lists usage events that have been dead-lettered (exhausted all retry
 * attempts).  Requires the X-Admin-Key header.
 *
 * Query params:
 *   - limit  (default 50, max 200)
 *   - offset (default 0)
 *
 * Response:
 * ```json
 * {
 *   "total": 3,
 *   "limit": 50,
 *   "offset": 0,
 *   "events": [ { ...UsageEventRecord } ]
 * }
 * ```
 */
deadLettersRouter.get(
  "/",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);

    const { events, total } = getDeadLetterEvents(limit, offset);
    return res.json({ total, limit, offset, events });
  }),
);

/**
 * POST /api/admin/dead-letters/:id/reprocess
 *
 * Requeues a single dead-lettered event for retry by resetting its status
 * to 'pending' and zeroing the attempt counter.  The retry worker will
 * pick it up on its next tick.
 *
 * Requires the X-Admin-Key header.
 *
 * Response (success):
 * ```json
 * { "message": "Event requeued", "event": { ...UsageEventRecord } }
 * ```
 *
 * Response (not found / wrong state):
 * ```json
 * { "error": "Event not found or not in dead-letter state" }
 * ```
 */
deadLettersRouter.post(
  "/:id/reprocess",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid event id" });
    }

    const event = requeueDeadLetterEvent(id);
    if (!event) {
      return res
        .status(404)
        .json({ error: "Event not found or not in dead-letter state" });
    }

    return res.json({ message: "Event requeued", event });
  }),
);
