import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger.js";
import { redact } from "./errorSanitizer.js";

export interface RequestLoggerOptions {
  /** Fraction (0-1) of successful (status < 400) requests to log. Errors are always logged. */
  sampleRate?: number;
}

/**
 * Express middleware that logs request/response pairs with a shared request_id.
 *
 * - Assigns a unique `request_id` per request (also set on the `X-Request-Id` response header).
 * - Redacts sensitive fields (secrets, tokens, passwords, API keys) from logged bodies.
 * - Samples successful requests (default 10%); errors (status >= 400) are always logged.
 * - Enable/disable via the `LOG_REQUESTS` env var (default: enabled).
 */
export function requestLogger(options: RequestLoggerOptions = {}) {
  const sampleRate = options.sampleRate ?? 0.1;

  return function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
    if (process.env.LOG_REQUESTS === "false") {
      return next();
    }

    const requestId = randomUUID();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startedAt = Date.now();

    res.on("finish", () => {
      const isError = res.statusCode >= 400;
      const sampled = isError || Math.random() < sampleRate;
      if (!sampled) return;

      logger.info("request", {
        type: "request",
        method: req.method,
        path: req.path,
        request_id: requestId,
        ip: req.ip,
        user_agent: req.get("user-agent"),
        body: redact(req.body),
      });

      logger.info("response", {
        type: "response",
        request_id: requestId,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        body_size: Number(res.get("content-length")) || 0,
      });
    });

    next();
  };
}
