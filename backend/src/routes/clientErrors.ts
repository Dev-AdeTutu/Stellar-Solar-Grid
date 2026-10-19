import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateRequest, ClientErrorReportSchema } from "../lib/validation.js";
import { logger } from "../lib/logger.js";

export const clientErrorsRouter = Router();

/**
 * POST /api/client-errors
 *
 * Centralized logging destination for errors caught by the frontend
 * ErrorBoundary, so render errors are captured even when no one is
 * watching the browser console in production. This logs via the existing
 * winston logger (JSON in production); wiring an external error-tracking
 * service (e.g. Sentry) is a separate product/tooling decision.
 */
clientErrorsRouter.post(
  "/",
  validateRequest({ body: ClientErrorReportSchema }),
  asyncHandler(async (req, res) => {
    const { message, stack, componentStack, url, userAgent } = req.body;

    logger.error("[ErrorBoundary] Client render error reported", {
      message,
      stack,
      componentStack,
      url,
      userAgent,
    });

    res.status(202).json({ received: true });
  }),
);
