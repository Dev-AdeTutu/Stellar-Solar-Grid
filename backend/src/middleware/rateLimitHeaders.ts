/**
 * middleware/rateLimitHeaders.ts
 *
 * Standard HTTP rate-limit response headers per the IETF rate-limit headers
 * draft (draft-ietf-httpapi-ratelimit-headers):
 *
 *   X-RateLimit-Limit     max requests in the window
 *   X-RateLimit-Remaining requests remaining in the window
 *   X-RateLimit-Reset     seconds until the limit resets (or epoch seconds)
 *   X-RateLimit-Policy    policy descriptor "limit;w=seconds"
 *
 * Scope-specific limits use a suffixed name, e.g. -Payments:
 *   X-RateLimit-Limit-Payments
 *   X-RateLimit-Remaining-Payments
 *   X-RateLimit-Reset-Payments
 *   X-RateLimit-Policy-Payments
 *
 * The individual rate limiters call `applyStandardRateLimitHeaders` as soon as
 * they know their current state so clients always see up-to-date headers.
 */
import type { Response } from "express";

export interface RateLimitInfo {
  /** Max requests allowed in the window for the matched limit. */
  limit: number;
  /** Requests remaining after the current one. */
  remaining: number;
  /** Unix ms timestamp when the window resets. */
  resetAtMs: number;
  /** Window length in ms for the policy descriptor. */
  windowMs: number;
}

/** Build a `limit;w=seconds` policy descriptor (IETF draft-7). */
export function policyHeader(limit: number, windowMs: number): string {
  const seconds = Math.max(1, Math.ceil(windowMs / 1000));
  return `${limit};w=${seconds}`;
}

/**
 * Attach `X-RateLimit-*` headers for a named scope (or the global scope).
 * Pass `retryAfter: true` to also emit `Retry-After` (for 429 responses).
 */
export function applyStandardRateLimitHeaders(
  res: Response,
  info: RateLimitInfo,
  opts: { scope?: string; retryAfter?: boolean } = {},
): void {
  const name = (base: string) =>
    opts.scope ? `${base}-${opts.scope}` : base;
  const reset = Math.max(0, Math.ceil((info.resetAtMs - Date.now()) / 1000));
  res.setHeader(name("X-RateLimit-Limit"), String(info.limit));
  res.setHeader(name("X-RateLimit-Remaining"), String(info.remaining));
  res.setHeader(name("X-RateLimit-Reset"), String(reset));
  res.setHeader(name("X-RateLimit-Policy"), policyHeader(info.limit, info.windowMs));
  if (opts.retryAfter) {
    res.setHeader("Retry-After", String(reset));
  }
}
