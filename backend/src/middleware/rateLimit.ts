/**
 * middleware/rateLimit.ts
 *
 * Exposes pre-configured express-rate-limit instances consumed by route
 * registrations in index.ts.
 *
 * Closes #539: all env-var parsing has been moved to
 * config/rateLimits.ts so there is a single source of truth shared between
 * this file and index.ts.
 *
 * Closes #734: each limiter emits BOTH the modern `RateLimit-*` headers and
 * the standard `X-RateLimit-*` headers (Limit / Remaining / Reset / Policy)
 * so clients can budget their requests before hitting a 429.
 */
import rateLimit from "express-rate-limit";
import {
  RATE_LIMIT_WINDOW_MS,
  PAYMENTS_RATE_LIMIT_WINDOW_MS,
  PAYMENTS_RATE_LIMIT_MAX,
  WRITE_RATE_LIMIT_MAX,
  RATE_LIMIT_MESSAGE,
} from "../config/rateLimits.js";
import { policyHeader } from "./rateLimitHeaders.js";

/**
 * writeLimiter — applied to mutating endpoints (admin login, webhooks,
 * allowlist, client-error reports).  More restrictive than the global read
 * limiter to protect write paths.
 */
export const writeLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: WRITE_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: true,
  handler: (_req, res) => {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    );
    res.setHeader(
      "X-RateLimit-Policy",
      policyHeader(WRITE_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS),
    );
    res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: "RATE_LIMITED" });
  },
});

/**
 * readLimiter — a permissive limiter for read-heavy endpoints.  4× the write
 * cap so read bursts don't trigger 429s during normal polling.
 */
export const readLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: WRITE_RATE_LIMIT_MAX * 4,
  standardHeaders: true,
  legacyHeaders: true,
  handler: (_req, res) => {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    );
    res.setHeader(
      "X-RateLimit-Policy",
      policyHeader(WRITE_RATE_LIMIT_MAX * 4, RATE_LIMIT_WINDOW_MS),
    );
    res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: "RATE_LIMITED" });
  },
});

/**
 * Legacy IP-based payment limiter retained for callers that need a standalone
 * limiter. The main payment route uses payerRateLimiter first so authenticated
 * requests are bucketed by payer address.
 */
export const paymentsLimiter = rateLimit({
  windowMs: PAYMENTS_RATE_LIMIT_WINDOW_MS,
  max: PAYMENTS_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: true,
  handler: (_req, res) => {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(PAYMENTS_RATE_LIMIT_WINDOW_MS / 1000)),
    );
    res.setHeader(
      "X-RateLimit-Policy",
      policyHeader(PAYMENTS_RATE_LIMIT_MAX, PAYMENTS_RATE_LIMIT_WINDOW_MS),
    );
    res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: "RATE_LIMITED" });
  },
});
