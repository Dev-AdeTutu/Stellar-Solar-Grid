import { Redis } from "ioredis";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { validateApiKey, type ApiKeyRecord } from "../lib/apiKeys.js";
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_MESSAGE,
  RATE_LIMIT_WINDOW_MS,
} from "../config/rateLimits.js";
import { applyStandardRateLimitHeaders } from "./rateLimitHeaders.js";
import { logger } from "../lib/logger.js";

export type RateLimitCounter = { count: number; resetAt: number };

export interface RateLimitStore {
  consume(key: string, windowMs: number, now: number): Promise<RateLimitCounter>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, RateLimitCounter>();

  async consume(key: string, windowMs: number, now: number): Promise<RateLimitCounter> {
    let counter = this.counters.get(key);
    if (!counter || counter.resetAt <= now) {
      counter = { count: 0, resetAt: now + windowMs };
    }
    counter.count += 1;
    this.counters.set(key, counter);

    if (this.counters.size > 10_000) {
      for (const [storedKey, value] of this.counters) {
        if (value.resetAt <= now) this.counters.delete(storedKey);
      }
      while (this.counters.size > 10_000) {
        const oldestKey = this.counters.keys().next().value;
        if (oldestKey === undefined) break;
        this.counters.delete(oldestKey);
      }
    }
    return counter;
  }
}

const REDIS_COUNTER_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async consume(key: string, windowMs: number, now: number): Promise<RateLimitCounter> {
    const [count, ttl] = (await this.redis.eval(
      REDIS_COUNTER_SCRIPT,
      1,
      key,
      String(windowMs),
    )) as [number, number];
    return { count: Number(count), resetAt: now + Number(ttl) };
  }
}

export type RateLimitTier = "read" | "write" | "admin";
export type RateLimitIdentity = { id: string; tier: RateLimitTier };

export type GlobalRateLimitOptions = {
  store?: RateLimitStore;
  resolveIdentity?: (req: Request) => RateLimitIdentity | undefined;
  ipLimit?: number;
  windowMs?: number;
  userLimits?: Record<RateLimitTier, number>;
};

const fallbackStore = new MemoryRateLimitStore();
let redisClient: Redis | undefined;
let redisStore: RedisRateLimitStore | undefined;

function defaultStore(): RateLimitStore {
  const url = process.env.REDIS_URL;
  if (!url) return fallbackStore;
  if (!redisStore) {
    redisClient = new Redis(url, {
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT ?? 2_000),
      commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT ?? 500),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redisClient.on("error", (error) => {
      if (process.env.NODE_ENV !== "test") {
        logger.error("[global-rate-limit] Redis error", { error: error.message });
      }
    });
    redisStore = new RedisRateLimitStore(redisClient);
  }
  return redisStore;
}

function identityFromApiKey(req: Request): RateLimitIdentity | undefined {
  const key = req.header("X-API-Key");
  if (!key) return undefined;
  const record: ApiKeyRecord | undefined = validateApiKey(key);
  if (!record) return undefined;
  const tier: RateLimitTier = record.permissions.includes("admin")
    ? "admin"
    : record.permissions.includes("write")
      ? "write"
      : "read";
  return { id: record.provider_id, tier };
}

function reject(res: Response, limit: number, counter: RateLimitCounter, windowMs: number, scope?: string) {
  const retryAfter = Math.max(1, Math.ceil((counter.resetAt - Date.now()) / 1000));
  applyStandardRateLimitHeaders(
    res,
    { limit, remaining: 0, resetAtMs: counter.resetAt, windowMs },
    { scope, retryAfter: true },
  );
  res.setHeader("Retry-After", String(retryAfter));
  return res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: "RATE_LIMITED", retryAfter });
}

export function createGlobalRateLimiter(options: GlobalRateLimitOptions = {}): RequestHandler {
  const store = options.store ?? defaultStore();
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const ipLimit = options.ipLimit ?? RATE_LIMIT_MAX;
  const userLimits = options.userLimits ?? {
    read: Number(process.env.RATE_LIMIT_USER_READ_MAX ?? 300),
    write: Number(process.env.RATE_LIMIT_USER_WRITE_MAX ?? 600),
    admin: Number(process.env.RATE_LIMIT_USER_ADMIN_MAX ?? 1_000),
  };
  const resolveIdentity = options.resolveIdentity ?? identityFromApiKey;

  return async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    let ipCounter: RateLimitCounter;
    try {
      ipCounter = await store.consume(`rl:ip:${ip}`, windowMs, now);
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        logger.error("[global-rate-limit] store error; using memory", { error });
      }
      ipCounter = await fallbackStore.consume(`rl:ip:${ip}`, windowMs, now);
    }

    const ipRemaining = Math.max(0, ipLimit - ipCounter.count);
    applyStandardRateLimitHeaders(res, {
      limit: ipLimit,
      remaining: ipRemaining,
      resetAtMs: ipCounter.resetAt,
      windowMs,
    });
    if (ipCounter.count > ipLimit) {
      return reject(res, ipLimit, ipCounter, windowMs);
    }

    const identity = resolveIdentity(req);
    if (identity) {
      const userLimit = userLimits[identity.tier];
      let userCounter: RateLimitCounter;
      try {
        userCounter = await store.consume(`rl:user:${identity.id}`, windowMs, now);
      } catch (error) {
        if (process.env.NODE_ENV !== "test") {
          logger.error("[global-rate-limit] user store error; using memory", { error });
        }
        userCounter = await fallbackStore.consume(`rl:user:${identity.id}`, windowMs, now);
      }
      const remaining = Math.max(0, userLimit - userCounter.count);
      applyStandardRateLimitHeaders(
        res,
        { limit: userLimit, remaining, resetAtMs: userCounter.resetAt, windowMs },
        { scope: "User" },
      );
      if (userCounter.count > userLimit) {
        return reject(res, userLimit, userCounter, windowMs, "User");
      }
    }

    return next();
  };
}

export const globalRateLimiter = createGlobalRateLimiter();