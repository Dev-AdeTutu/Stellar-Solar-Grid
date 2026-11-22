import { describe, it, expect, beforeEach } from "vitest";

process.env.RATE_LIMIT_TIERS_DB_PATH = ":memory:";

import { getTier, setTier, _resetTieredRateLimit, _resetTieredRateLimitCache } from "../src/lib/tieredRateLimit";

describe("rate-limit tier persistence (#1129)", () => {
  beforeEach(() => _resetTieredRateLimit());

  it("defaults to free", () => {
    expect(getTier("c1")).toBe("free");
  });

  it("keeps an upgraded tier after in-memory state is lost (restart)", () => {
    setTier("c1", "premium");
    _resetTieredRateLimitCache();
    expect(getTier("c1")).toBe("premium");
  });

  it("overwrites a persisted tier on a later upgrade", () => {
    setTier("c1", "basic");
    setTier("c1", "enterprise");
    _resetTieredRateLimitCache();
    expect(getTier("c1")).toBe("enterprise");
  });

  it("upgrading after a cached default takes effect", () => {
    expect(getTier("c2")).toBe("free");
    setTier("c2", "basic");
    expect(getTier("c2")).toBe("basic");
  });
});
