/**
 * Tiered rate-limit middleware (#1080). Consumers are identified by the
 * `X-API-Key` header, falling back to `X-User-Id`, then client IP.
 */
import type { NextFunction, Request, Response } from "express";
import { consume } from "../lib/tieredRateLimit.js";

export function consumerIdOf(req: Request): string {
  return (req.header("x-api-key") ?? req.header("x-user-id") ?? req.ip ?? "anonymous").trim();
}

export function tieredRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const result = consume(consumerIdOf(req));
  res.setHeader("X-RateLimit-Tier", result.tier);
  res.setHeader("X-RateLimit-Limit", String(result.limitPerMinute));
  res.setHeader("X-RateLimit-Remaining", String(result.remainingMinute));
  res.setHeader("X-RateLimit-Daily-Limit", String(result.limitPerDay));
  res.setHeader("X-RateLimit-Daily-Remaining", String(result.remainingDay));
  if (result.upgrade) res.setHeader("X-RateLimit-Upgrade", result.upgrade.suggestedTier);
  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({ error: "Rate limit exceeded", tier: result.tier, retryAfterSeconds: result.retryAfterSeconds, upgrade: result.upgrade ?? null });
    return;
  }
  next();
}
