import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";

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

process.env.METER_METADATA_DB_PATH = ":memory:";

import { createMeterRouter } from "../src/routes/meters";
import { stellarService } from "../src/lib/stellar";
import { indexMeterLocation } from "../src/lib/meterMetadataIndex";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("metersRouter - GET /api/meters/search (Issue #819)", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;
  let router: any;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    req = {
      query: {},
      params: {},
    };
    res = {
      json: jsonMock,
      status: statusMock,
    };

    router = createMeterRouter(stellarService);
  });

  it("should return 400 when location query parameter is missing", async () => {
    req.query = {};

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/search" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "location query parameter is required",
        code: "VALIDATION_ERROR",
      })
    );
  });

  it("should return partial and case-insensitive matching meters", async () => {
    const mockMeters = [
      { id: "M1", owner: "user1", metadata: { location: "Building A - Floor 2" } },
      { id: "M2", owner: "user2", metadata: { location: "Building B" } },
      { id: "M3", owner: "user3", location: "building a - Room 101" },
      { id: "M4", owner: "user4", metadata: { location: "Warehouse North" } },
    ];

    (stellarService.query as any).mockResolvedValue(
      StellarSdk.nativeToScVal(mockMeters)
    );

    req.query = { location: "building a" };

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/search" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(jsonMock).toHaveBeenCalledWith({
      meters: [
        { id: "M1", owner: "user1", metadata: { location: "Building A - Floor 2" } },
        { id: "M3", owner: "user3", location: "building a - Room 101" },
      ],
      pagination: {
        page: 1,
        pageSize: 20,
        total: 2,
        pages: 1,
      },
    });
  });

  it("should support pagination in search results", async () => {
    const mockMeters = [
      { id: "M1", location: "Building A - Room 1" },
      { id: "M2", location: "Building A - Room 2" },
      { id: "M3", location: "Building A - Room 3" },
    ];

    (stellarService.query as any).mockResolvedValue(
      StellarSdk.nativeToScVal(mockMeters)
    );

    req.query = { location: "Building A", page: "2", pageSize: "1" };

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/search" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(jsonMock).toHaveBeenCalledWith({
      meters: [{ id: "M2", location: "Building A - Room 2" }],
      pagination: {
        page: 2,
        pageSize: 1,
        total: 3,
        pages: 3,
      },
    });
  });

  it("should fallback to SQLite metadata index when stellar returns no meters", async () => {
    (stellarService.query as any).mockRejectedValue(new Error("stellar query failed"));

    indexMeterLocation("M_SQLITE_1", "Building A - Annex", { zone: "east" });
    indexMeterLocation("M_SQLITE_2", "Compound C", { zone: "south" });

    req.query = { location: "building a" };

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/search" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meters: expect.arrayContaining([
          expect.objectContaining({
            meter_id: "M_SQLITE_1",
            location: "Building A - Annex",
          }),
        ]),
        pagination: expect.objectContaining({
          total: 1,
        }),
      })
    );
  });
});
