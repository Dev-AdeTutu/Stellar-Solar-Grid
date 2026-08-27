import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedisCache, CACHE_TTL } from "../src/lib/redisCache.js";

describe("RedisCache layer (Issue #752)", () => {
  beforeEach(async () => {
    await RedisCache.del([
      RedisCache.meterBalanceKey("TEST_M1"),
      RedisCache.statsKey("overview"),
      RedisCache.contractMetadataKey(),
    ]);
  });

  it("caches and retrieves values with TTL", async () => {
    const key = RedisCache.meterBalanceKey("TEST_M1");
    const mockData = { meter_id: "TEST_M1", balance: "5000000", active: true };

    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return mockData;
    };

    // First call: calls fetcher
    const res1 = await RedisCache.getOrSet(key, CACHE_TTL.METER_BALANCE, fetcher);
    expect(res1).toEqual(mockData);
    expect(fetchCount).toBe(1);

    // Second call: serves from cache
    const res2 = await RedisCache.getOrSet(key, CACHE_TTL.METER_BALANCE, fetcher);
    expect(res2).toEqual(mockData);
    expect(fetchCount).toBe(1);
  });

  it("invalidates cache on state change", async () => {
    const key = RedisCache.meterBalanceKey("TEST_M1");
    const initialData = { meter_id: "TEST_M1", balance: "5000000", active: true };
    const updatedData = { meter_id: "TEST_M1", balance: "6000000", active: true };

    let data = initialData;
    const fetcher = async () => data;

    await RedisCache.getOrSet(key, CACHE_TTL.METER_BALANCE, fetcher);

    // Invalidate
    await RedisCache.invalidateMeter("TEST_M1");

    // Fetch again with updated data
    data = updatedData;
    const res = await RedisCache.getOrSet(key, CACHE_TTL.METER_BALANCE, fetcher);
    expect(res.balance).toBe("6000000");
  });

  it("falls back to fetcher when get returns null", async () => {
    const key = RedisCache.statsKey("overview");
    const statsData = { totalMeters: 10, activeMeters: 8 };

    const res = await RedisCache.getOrSet(key, CACHE_TTL.STATS_AGGREGATES, async () => statsData);
    expect(res).toEqual(statsData);
  });
});
