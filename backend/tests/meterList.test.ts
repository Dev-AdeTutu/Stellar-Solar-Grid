import { describe, expect, it } from "vitest";
import { filterMeters, paginateMeters } from "../src/lib/meterList.js";

describe("meter list filters and pagination", () => {
  const meters = [
    { id: "M1", active: false, owner: "owner-a", plan: "Daily", expires_at: 1_800_000_000 },
    { id: "M2", active: false, owner: "owner-b", plan: "Daily", expires_at: 1_800_000_000 },
    { id: "M3", active: true, owner: "owner-a", plan: "Weekly", expires_at: 2_000_000_000 },
  ];

  it("filters offline meters before computing the total and slicing a page", () => {
    const filtered = filterMeters(meters, { status: "offline" });
    const result = paginateMeters(filtered, 2, 1);

    expect(result).toEqual({ meters: [meters[1]], total: 2, pages: 2 });
  });

  it("combines status with owner, active, plan, and expiry filters", () => {
    const filtered = filterMeters(meters, {
      status: "offline",
      owner: "owner-a",
      active: "false",
      plan: "daily",
      expiresBeforeMs: 1_900_000_000_000,
    });

    expect(filtered).toEqual([meters[0]]);
  });

  it("supports online and active filters without double-counting rows", () => {
    expect(filterMeters(meters, { status: "online" })).toEqual([meters[2]]);
    expect(filterMeters(meters, { active: "true" })).toEqual([meters[2]]);
    expect(filterMeters(meters, { status: "offline", active: "true" })).toEqual([]);
  });
});
