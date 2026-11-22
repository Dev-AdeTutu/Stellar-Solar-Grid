import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/emergencyContacts.js", () => ({
  notifyEmergencyContacts: vi.fn().mockResolvedValue({}),
}));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssg-1124-"));
process.env.RATE_LIMIT_TIERS_DB_PATH = path.join(tmpDir, "tiers.sqlite");

import { OutageService } from "../src/services/outageService.js";
import { TheftDetectionService, parseNumericScore, scoreExceedsThreshold } from "../src/services/theftDetectionService.js";
import { filterMeters, paginateMeters, parseMeterPagination } from "../src/lib/meterList.js";

afterAll(async () => {
  const { closeAllDatabases } = await import("../src/lib/databaseLifecycle.js");
  closeAllDatabases();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows may keep SQLite WAL handles briefly; the OS temp dir is disposable.
  }
});

describe("#1124 rate-limit tier persistence", () => {
  it("keeps an upgraded tier after a simulated server restart", async () => {
    vi.resetModules();
    const first = await import("../src/lib/tieredRateLimit.js");
    first._resetTieredRateLimit();
    expect(first.getTier("consumer-1")).toBe("free");
    first.setTier("consumer-1", "premium");
    expect(first.getTier("consumer-1")).toBe("premium");

    // New module instance == fresh process memory, same database file.
    vi.resetModules();
    const second = await import("../src/lib/tieredRateLimit.js");
    expect(second.getTier("consumer-1")).toBe("premium");
    expect(second.getUsage("consumer-1").limits.requestsPerMinute).toBe(300);
    expect(second.getTier("someone-else")).toBe("free");
  });

  it("persists the latest tier when a consumer is upgraded twice", async () => {
    vi.resetModules();
    const first = await import("../src/lib/tieredRateLimit.js");
    first.setTier("consumer-2", "basic");
    first.setTier("consumer-2", "enterprise");

    vi.resetModules();
    const second = await import("../src/lib/tieredRateLimit.js");
    expect(second.getTier("consumer-2")).toBe("enterprise");
  });
});

describe("#1125 outage events are emitted once per outage", () => {
  let service: OutageService;
  beforeEach(() => {
    service = new OutageService();
  });

  it("does not emit twice when two detection sources report the same outage", () => {
    const listener = vi.fn();
    service.on("outage:detected", listener);

    const viaMqtt = service.createOutage({ region: "north", affectedMeters: ["M1", "M2"] });
    const viaPolling = service.createOutage({ region: "north", affectedMeters: ["M2", "M3"] });

    expect(viaPolling.id).toBe(viaMqtt.id);
    expect(service.getActiveOutages()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // Newly reported meters are merged into the tracked outage.
    expect(viaMqtt.affectedMeters).toEqual(["M1", "M2", "M3"]);
  });

  it("treats a repeated caller-supplied outage ID as the same outage", () => {
    const listener = vi.fn();
    service.on("outage:detected", listener);
    service.createOutage({ id: "ext-42", region: "a", affectedMeters: ["M1"] });
    service.createOutage({ id: "ext-42", region: "b", affectedMeters: ["M9"] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getActiveOutages()).toHaveLength(1);
  });

  it("still emits for distinct outages and for a new outage after resolution", () => {
    const listener = vi.fn();
    service.on("outage:detected", listener);
    const a = service.createOutage({ region: "north", affectedMeters: ["M1"] });
    service.createOutage({ region: "south", affectedMeters: ["M1"] });
    service.createOutage({ region: "north", affectedMeters: ["M7"] });
    expect(listener).toHaveBeenCalledTimes(3);

    service.resolveOutage(a.id);
    service.createOutage({ region: "north", affectedMeters: ["M1"] });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("findExistingOutage reports duplicates without creating anything", () => {
    expect(service.findExistingOutage({ region: "x", affectedMeters: ["M1"] })).toBeUndefined();
    const created = service.createOutage({ region: "x", affectedMeters: ["M1"] });
    expect(service.findExistingOutage({ region: "x", affectedMeters: ["M1"] })).toBe(created);
    expect(service.getActiveOutages()).toHaveLength(1);
  });
});

describe("#1126 theft score threshold uses numeric comparison", () => {
  it("does not let the string '9.5' pass a threshold of 10, in either direction", () => {
    expect(scoreExceedsThreshold("9.5", 10)).toBe(false);
    expect(scoreExceedsThreshold("9.5", "10")).toBe(false);
    expect(scoreExceedsThreshold("10.5", 10)).toBe(true);
    expect(scoreExceedsThreshold("100", "9")).toBe(true); // lexicographically "100" < "9"
  });

  it("rejects non-numeric, blank, null and boolean inputs instead of coercing them", () => {
    expect(parseNumericScore("")).toBeUndefined();
    expect(parseNumericScore("  ")).toBeUndefined();
    expect(parseNumericScore(null)).toBeUndefined();
    expect(parseNumericScore(true)).toBeUndefined();
    expect(parseNumericScore("abc")).toBeUndefined();
    expect(parseNumericScore(Number.NaN)).toBeUndefined();
    expect(parseNumericScore(" 9.5 ")).toBe(9.5);
    // A blank threshold must not behave like 0 and raise alerts for every score.
    expect(scoreExceedsThreshold(5, "")).toBe(false);
    expect(scoreExceedsThreshold(5, null)).toBe(false);
  });

  it("supports an inclusive boundary", () => {
    expect(scoreExceedsThreshold("70", 70)).toBe(false);
    expect(scoreExceedsThreshold("70", 70, true)).toBe(true);
  });

  it("still raises a provider alert exactly at the 70 risk-score boundary", () => {
    const service = new TheftDetectionService();
    service.trainNormalPatternModel("M", [
      { timestamp: "2026-10-10T09:00:00Z", kwh: 5 },
      { timestamp: "2026-10-11T09:00:00Z", kwh: 5 },
    ]);
    // Two zero-load readings (35 + 35) hit exactly 70.
    const result = service.analyzeMeterTheft("M", [
      { timestamp: "2026-10-16T09:00:00Z", kwh: 0 },
      { timestamp: "2026-10-17T09:00:00Z", kwh: 0 },
    ]);
    expect(result.riskScore).toBe(70);
    expect(result.alert).not.toBeNull();
  });
});

describe("#1127 /api/meters total reflects filters", () => {
  const meters = [
    ...Array.from({ length: 15 }, (_, i) => ({ id: `off-${i}`, owner: "o", active: false, plan: "Daily" })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `on-${i}`, owner: "o", active: true, plan: "Daily" })),
  ];

  // Mirrors the handler: parse pagination, filter, then paginate the filtered set.
  function list(query: Record<string, string>) {
    const { page, pageSize } = parseMeterPagination(query);
    return { pageSize, ...paginateMeters(filterMeters(meters, { status: query.status }), page, pageSize) };
  }

  it("counts only filtered rows and honours the limit alias", () => {
    const result = list({ status: "offline", limit: "10" });
    expect(result.total).toBe(15);
    expect(result.meters).toHaveLength(10);
    expect(result).toMatchObject({ pageSize: 10, pages: 2 });
    expect(result.meters.every((m) => m.active === false)).toBe(true);
  });

  it("returns the unfiltered total only when no filter is supplied", () => {
    expect(list({ pageSize: "5" }).total).toBe(20);
  });

  it("prefers pageSize over limit and clamps invalid values", () => {
    expect(list({ status: "online", pageSize: "2", limit: "4" }).meters).toHaveLength(2);
    expect(parseMeterPagination({ limit: "500" }).pageSize).toBe(100);
    expect(parseMeterPagination({ limit: "0" }).pageSize).toBe(25);
    expect(parseMeterPagination({ limit: "abc", page: "-3" })).toEqual({ page: 1, pageSize: 25 });
  });
});
