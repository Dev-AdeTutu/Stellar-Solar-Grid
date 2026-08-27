import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";

// Mock the stellar module before importing routes
vi.mock("../src/lib/stellar", () => ({
  stellarService: {
    invoke: vi.fn(),
    query: vi.fn(),
    contractId: "C123",
    server: {},
    adminKeypair: {},
    networkPassphrase: "test",
  },
}));

// Set in-memory db path before imports to avoid writing to real database file
process.env.USAGE_EVENTS_DB_PATH = ":memory:";

import { createMeterRouter } from "../src/routes/meters";
import { stellarService } from "../src/lib/stellar";
import { initUsageEventStore } from "../src/lib/usageEvents";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("metersRouter - GET /api/meters/inactive", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;
  let router: any;
  let db: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    
    req = {
      query: {},
      headers: {
        "x-admin-key": "test-admin-key",
      },
    };
    res = {
      json: jsonMock,
      status: statusMock,
    };

    process.env.ADMIN_KEY = "test-admin-key";

    router = createMeterRouter(stellarService);
    db = initUsageEventStore();
    // Clear usage_events table for a clean test
    db.exec("DELETE FROM usage_events");
  });

  it("should verify requireAdminKey middleware is registered", async () => {
    const route = router.stack.find(
      (layer: any) => layer.route?.path === "/inactive" && layer.route?.methods.get
    )?.route;
    
    expect(route).toBeDefined();
    const middlewareNames = route.stack.map((layer: any) => layer.name);
    expect(middlewareNames).toContain("requireAdminKey");
  });

  it("should list inactive meters and map their last_used from DB", async () => {
    const mockMeters = [
      { id: "active-meter", owner: "user1", active: true },
      { id: "inactive-meter-1", owner: "user2", active: false },
      { id: "inactive-meter-2", owner: "user3", active: false },
    ];
    (stellarService.query as any).mockResolvedValue(
      StellarSdk.nativeToScVal(mockMeters)
    );

    const nowStr1 = "2026-07-09T12:00:00.000Z";
    const nowStr2 = "2026-07-09T13:00:00.000Z";
    
    db.prepare(
      "INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, ?, ?, ?)"
    ).run("inactive-meter-1", 10, "100", nowStr1, "submitted");

    db.prepare(
      "INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, ?, ?, ?)"
    ).run("inactive-meter-1", 5, "50", nowStr2, "submitted");

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/inactive" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(jsonMock).toHaveBeenCalledWith({
      inactive: [
        { id: "inactive-meter-1", owner: "user2", active: false, last_used: nowStr2 },
        { id: "inactive-meter-2", owner: "user3", active: false, last_used: null },
      ],
      count: 2,
    });
  });
});
