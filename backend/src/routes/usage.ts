import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  addUsageHistory,
  getUsageHistory,
} from "../lib/usageHistory.js";

export const usageRouter = Router();

/**
 * POST /api/usage/:meterId
 * Logs usage updates into the usage_history database.
 */
usageRouter.post(
  "/:meterId",
  asyncHandler(async (req, res) => {
    const { meterId } = req.params;
    if (!meterId || typeof meterId !== "string" || meterId.trim() === "") {
      return res.status(400).json({
        error: "Missing or invalid meterId parameter",
        code: "VALIDATION_ERROR",
      });
    }

    const { units, timestamp } = req.body ?? {};
    const balanceBeforeRaw = req.body?.balance_before ?? req.body?.balanceBefore;
    const balanceAfterRaw = req.body?.balance_after ?? req.body?.balanceAfter;

    if (
      units === undefined ||
      units === null ||
      typeof Number(units) !== "number" ||
      isNaN(Number(units)) ||
      Number(units) < 0
    ) {
      return res.status(400).json({
        error: "Invalid or missing 'units' field. Must be a non-negative number.",
        code: "VALIDATION_ERROR",
      });
    }

    if (
      balanceBeforeRaw === undefined ||
      balanceBeforeRaw === null ||
      isNaN(Number(balanceBeforeRaw))
    ) {
      return res.status(400).json({
        error: "Invalid or missing 'balance_before' field.",
        code: "VALIDATION_ERROR",
      });
    }

    if (
      balanceAfterRaw === undefined ||
      balanceAfterRaw === null ||
      isNaN(Number(balanceAfterRaw))
    ) {
      return res.status(400).json({
        error: "Invalid or missing 'balance_after' field.",
        code: "VALIDATION_ERROR",
      });
    }

    let finalTimestamp = timestamp;
    if (finalTimestamp) {
      const parsedDate = new Date(finalTimestamp);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          error: "Invalid timestamp format. Must be an ISO-8601 string or valid date.",
          code: "VALIDATION_ERROR",
        });
      }
      finalTimestamp = parsedDate.toISOString();
    } else {
      finalTimestamp = new Date().toISOString();
    }

    const record = addUsageHistory({
      meter_id: meterId.trim(),
      units: Number(units),
      balance_before: Number(balanceBeforeRaw),
      balance_after: Number(balanceAfterRaw),
      timestamp: finalTimestamp,
    });

    return res.status(201).json(record);
  }),
);

/**
 * GET /api/usage/:meterId?from=&to=&limit=50
 * Returns paginated usage history.
 */
usageRouter.get(
  "/:meterId",
  asyncHandler(async (req, res) => {
    const { meterId } = req.params;
    if (!meterId || typeof meterId !== "string" || meterId.trim() === "") {
      return res.status(400).json({
        error: "Missing or invalid meterId parameter",
        code: "VALIDATION_ERROR",
      });
    }

    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const limit =
      req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : 50;
    const page =
      req.query.page !== undefined ? parseInt(String(req.query.page), 10) : 1;
    const offset =
      req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : undefined;

    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({
        error: "Invalid limit parameter. Must be a positive integer.",
        code: "VALIDATION_ERROR",
      });
    }

    if (isNaN(page) || page < 1) {
      return res.status(400).json({
        error: "Invalid page parameter. Must be a positive integer.",
        code: "VALIDATION_ERROR",
      });
    }

    const result = getUsageHistory(meterId.trim(), {
      from,
      to,
      limit,
      page,
      offset,
    });

    return res.json({
      meterId: meterId.trim(),
      history: result.history,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        page: result.page,
        pages: result.pages,
      },
    });
  }),
);
