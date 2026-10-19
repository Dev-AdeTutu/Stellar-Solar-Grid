import Redis from "ioredis";
import { logger } from "./logger.js";

export const CACHE_TTL = {
  METER_BALANCE: Number(process.env.CACHE_TTL_METER_BALANCE ?? 300), // 5 minutes (300s)
  STATS_AGGREGATES: Number(process.env.CACHE_TTL_STATS ?? 30),       // 30 seconds
  CONTRACT_METADATA: Number(process.env.CACHE_TTL_METADATA ?? 3600), // 1 hour (3600s)
};

// In-memory fallback map when Redis is unavailable
const memoryFallback = new Map<string, { value: string; expiresAt: number }>();

let redisClient: Redis | null = null;
let isRedisAvailable = false;

export function initRedis(): Redis | null {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl && !process.env.ENABLE_REDIS) {
    logger.info("Redis caching running in in-memory fallback mode");
    return null;
  }

  try {
    redisClient = redisUrl
      ? new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          lazyConnect: true,
          connectTimeout: 3000,
        })
      : new Redis({
          host: process.env.REDIS_HOST ?? "127.0.0.1",
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          lazyConnect: true,
          connectTimeout: 3000,
        });

    redisClient.on("connect", () => {
      isRedisAvailable = true;
      logger.info("Connected to Redis caching layer");
    });

    redisClient.on("error", (err) => {
      isRedisAvailable = false;
      logger.warn("Redis connection error, falling back to in-memory/direct RPC", { error: err.message });
    });

    redisClient.connect().catch((err) => {
      isRedisAvailable = false;
      logger.warn("Could not establish initial Redis connection; using memory fallback", { error: err.message });
    });

    return redisClient;
  } catch (err: any) {
    isRedisAvailable = false;
    logger.warn("Failed to initialize Redis client, using in-memory fallback", { error: err.message });
    return null;
  }
}

export const RedisCache = {
  async get<T>(key: string): Promise<T | null> {
    if (isRedisAvailable && redisClient) {
      try {
        const raw = await redisClient.get(key);
        if (raw !== null) {
          return JSON.parse(raw) as T;
        }
      } catch (err: any) {
        logger.warn("Redis get failed, falling back to memory", { key, error: err.message });
      }
    }

    const mem = memoryFallback.get(key);
    if (mem && Date.now() < mem.expiresAt) {
      try {
        return JSON.parse(mem.value) as T;
      } catch {
        return null;
      }
    }
    if (mem) {
      memoryFallback.delete(key);
    }
    return null;
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);

    if (isRedisAvailable && redisClient) {
      try {
        await redisClient.set(key, serialized, "EX", ttlSeconds);
      } catch (err: any) {
        logger.warn("Redis set failed, saving to memory fallback", { key, error: err.message });
      }
    }

    // Always maintain memory fallback for reliability
    if (memoryFallback.size > 2000) {
      const now = Date.now();
      for (const [k, v] of memoryFallback.entries()) {
        if (now >= v.expiresAt) memoryFallback.delete(k);
      }
      if (memoryFallback.size > 2000) memoryFallback.clear();
    }
    memoryFallback.set(key, {
      value: serialized,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },

  async del(keys: string | string[]): Promise<void> {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    if (keyArray.length === 0) return;

    for (const k of keyArray) {
      memoryFallback.delete(k);
    }

    if (isRedisAvailable && redisClient) {
      try {
        await redisClient.del(...keyArray);
      } catch (err: any) {
        logger.warn("Redis del failed", { keys: keyArray, error: err.message });
      }
    }
  },

  async invalidatePattern(prefix: string): Promise<void> {
    for (const k of memoryFallback.keys()) {
      if (k.startsWith(prefix)) {
        memoryFallback.delete(k);
      }
    }

    if (isRedisAvailable && redisClient) {
      try {
        const stream = redisClient.scanStream({ match: `${prefix}*`, count: 100 });
        stream.on("data", (keys: string[]) => {
          if (keys.length > 0) {
            redisClient?.del(...keys).catch(() => {});
          }
        });
      } catch (err: any) {
        logger.warn("Redis invalidatePattern failed", { prefix, error: err.message });
      }
    }
  },

  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Direct fallback fetcher (RPC / DB)
    const fresh = await fetcher();
    if (fresh !== undefined && fresh !== null) {
      await this.set(key, fresh, ttlSeconds).catch(() => {});
    }
    return fresh;
  },

  // Key formatters
  meterBalanceKey(meterId: string): string {
    return `solargrid:meter:${meterId}:balance`;
  },

  meterDataKey(meterId: string): string {
    return `solargrid:meter:${meterId}:data`;
  },

  statsKey(type: string): string {
    return `solargrid:stats:${type}`;
  },

  contractMetadataKey(): string {
    return `solargrid:contract:metadata`;
  },

  async invalidateMeter(meterId: string): Promise<void> {
    await this.del([
      this.meterBalanceKey(meterId),
      this.meterDataKey(meterId),
    ]);
    await this.invalidatePattern("solargrid:stats:");
  },
};

// Initialize on load
initRedis();
