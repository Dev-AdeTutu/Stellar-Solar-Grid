import { Redis } from "ioredis";
import type { NextFunction, Request, Response, RequestHandler } from "express";
import {
  PAYMENTS_RATE_LIMIT_MAX,
  PAYMENTS_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MESSAGE,
} from "../config/rateLimits.js";
import { applyStandardRateLimitHeaders } from "./rateLimitHeaders.js";

export type PayerRateLimitResult = {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
  limit: number;
};

export interface PayerRateLimitStore {
  check(key: string, now: number): Promise<PayerRateLimitResult>;
  clear?(): void | Promise<void>;
}

function resultFromCount(count: number, oldest: number, now: number): PayerRateLimitResult {
  const resetAt = oldest > 0 ? oldest + PAYMENTS_RATE_LIMIT_WINDOW_MS : now + PAYMENTS_RATE_LIMIT_WINDOW_MS;
  return {
    allowed: count <= PAYMENTS_RATE_LIMIT_MAX,
    count,
    remaining: Math.max(0, PAYMENTS_RATE_LIMIT_MAX - count),
    resetAt,
    limit: PAYMENTS_RATE_LIMIT_MAX,
  };
}

/** Precise sliding-window store for single-instance deployments and fallback. */
export class MemoryPayerRateLimitStore implements PayerRateLimitStore {
  private readonly buckets = new Map<string, number[]>();

  async check(key: string, now = Date.now()): Promise<PayerRateLimitResult> {
    const cutoff = now - PAYMENTS_RATE_LIMIT_WINDOW_MS;
    const active = (this.buckets.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    active.push(now);
    this.buckets.set(key, active);
    return resultFromCount(active.length, active[0] ?? 0, now);
  }

  clear() {
    this.buckets.clear();
  }
}

const REDIS_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local cutoff = now - window_ms

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local sequence = redis.call('INCR', key .. ':sequence')
redis.call('ZADD', key, now, tostring(now) .. ':' .. tostring(sequence))
redis.call('EXPIRE', key, ttl_seconds)
redis.call('EXPIRE', key .. ':sequence', ttl_seconds)

local count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldest_score = 0
if #oldest > 0 then
  oldest_score = tonumber(oldest[2])
end
return { count, oldest_score }
`;

/** Redis-backed sliding window for multi-instance deployments. */
export class RedisPayerRateLimitStore implements PayerRateLimitStore {
  private readonly ttlSeconds = Math.ceil(PAYMENTS_RATE_LIMIT_WINDOW_MS / 1000) + 1;

  constructor(private readonly redis: Redis) {}

  async check(key: string, now = Date.now()): Promise<PayerRateLimitResult> {
    const [count, oldest] = (await this.redis.eval(
      REDIS_WINDOW_SCRIPT,
      1,
      key,
      String(now),
      String(PAYMENTS_RATE_LIMIT_WINDOW_MS),
      String(PAYMENTS_RATE_LIMIT_MAX),
      String(this.ttlSeconds),
    )) as [number, number];
    return resultFromCount(Number(count), Number(oldest), now);
  }
}

let redisClient: Redis | null | undefined;
let defaultStore: PayerRateLimitStore | undefined;
const fallbackStore = new MemoryPayerRateLimitStore();

function getRedisClient(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return redisClient;
  }

  try {
    const client = new Redis(url, {
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT ?? 2_000),
      commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT ?? 500),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on("error", (error) => {
      if (process.env.NODE_ENV !== "test") {
        console.error("[payer-rate-limit] Redis error:", error.message);
      }
    });
    redisClient = client;
  } catch (error) {
    console.error("[payer-rate-limit] Redis setup failed; using memory:", error);
    redisClient = null;
  }
  return redisClient;
}

function getDefaultStore(): PayerRateLimitStore {
  if (!defaultStore) {
    const redis = getRedisClient();
    defaultStore = redis ? new RedisPayerRateLimitStore(redis) : fallbackStore;
  }
  return defaultStore;
}

/**
 * Extract the payer identity after express.json has parsed the request body.
 * Registration uses `owner`; payment uses `payer`; callers may also provide
 * X-Payer-Address for meter-management operations whose body lacks an owner.
 */
export function extractPayerAddress(req: Request): string | null {
  const header = req.header("x-payer-address");
  const body = req.body as Record<string, unknown> | undefined;
  const candidate = body?.payer ?? body?.owner ?? body?.new_owner ?? header;
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  return value.length > 0 ? value : null;
}

function addRateLimitHeaders(res: Response, result: PayerRateLimitResult) {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  // Issue #734: emit BOTH the legacy `RateLimit-*` headers and the standard
  // `X-RateLimit-*` headers (including a `-Payments` scope-specific variant so
  // payment clients see their tighter budget without ambiguity).
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(retryAfter));
  applyStandardRateLimitHeaders(
    res,
    {
      limit: result.limit,
      remaining: result.remaining,
      resetAtMs: result.resetAt,
      windowMs: PAYMENTS_RATE_LIMIT_WINDOW_MS,
    },
    { scope: "Payments" },
  );
  return retryAfter;
}

/** Create an injectable payer limiter for route tests and deployments. */
export function createPayerRateLimiter(store: PayerRateLimitStore = getDefaultStore()): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const payer = extractPayerAddress(req);
    if (!payer) {
      // Anonymous requests remain governed by the global IP limiter.
      return next();
    }

    const key = `rl:payer:${payer}`;
    let result: PayerRateLimitResult;
    try {
      result = await store.check(key, Date.now());
    } catch (error) {
      // Redis is an optimization for sharing state; an outage must not make the
      // API unavailable. Fall back to this instance’s bounded memory store.
      if (process.env.NODE_ENV !== "test") {
        console.error("[payer-rate-limit] store error; using memory:", error);
      }
      result = await fallbackStore.check(key, Date.now());
    }

    const retryAfter = addRateLimitHeaders(res, result);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: RATE_LIMIT_MESSAGE,
        code: "RATE_LIMITED",
        retryAfter,
      });
    }
    return next();
  };
}

export const payerRateLimiter = createPayerRateLimiter();

/** Test-only reset hook; it does not affect Redis data. */
export async function resetPayerRateLimiterState() {
  fallbackStore.clear();
  if (defaultStore?.clear) await defaultStore.clear();
}
