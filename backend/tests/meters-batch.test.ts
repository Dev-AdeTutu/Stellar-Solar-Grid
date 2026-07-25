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

import { createMeterRouter } from "../src/routes/meters";
import { stellarService } from "../src/lib/stellar";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("metersRouter - POST /api/meters/batch", () => {
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
      body: {},
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
  });

  it("should fail if meters array is missing or not an array", async () => {
    req.body = {};
    
    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/batch" && layer.route?.methods.post
    )?.route?.stack.slice(-1)[0]?.handle;

    if (!handler) {
      throw new Error("Batch registration endpoint handler not found");
    }

    await handler(req, res);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "meters array is required",
      code: "VALIDATION_ERROR",
    });
  });

  it("should fail if meters array has more than 50 items", async () => {
    req.body = {
      meters: Array.from({ length: 51 }, (_, i) => ({
        meter_id: `m${i}`,
        owner: "GCFJQANBW7ZMPW73MFD4IJBCNWGVWCE5QEGFBJWCF5NJDEBXADZBMRMC",
      })),
    };
    
    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/batch" && layer.route?.methods.post
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "At most 50 meters can be registered in a batch",
      code: "VALIDATION_ERROR",
    });
  });

  it("should register valid meters and return individual item results", async () => {
    (stellarService.invoke as any).mockResolvedValue("mock-tx-hash");

    req.body = {
      meters: [
        {
          meter_id: "meter1",
          owner: "GCFJQANBW7ZMPW73MFD4IJBCNWGVWCE5QEGFBJWCF5NJDEBXADZBMRMC",
        },
        {
          meter_id: "meter2_too_long_id",
          owner: "GCFJQANBW7ZMPW73MFD4IJBCNWGVWCE5QEGFBJWCF5NJDEBXADZBMRMC",
        },
        {
          meter_id: "meter3",
          owner: "invalid-address",
        },
      ],
    };

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/batch" && layer.route?.methods.post
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);
    expect(stellarService.invoke).toHaveBeenCalledTimes(1); // Only meter1 is valid
    const responseData = jsonMock.mock.calls[0][0];



    expect(responseData.results).toHaveLength(3);
    expect(responseData.results[0]).toEqual({
      meter_id: "meter1",
      hash: "mock-tx-hash",
    });
    expect(responseData.results[1]).toEqual({
      meter_id: "meter2_too_long_id",
      error: "meter_id must be at most 12 characters",
    });
    expect(responseData.results[2]).toEqual({
      meter_id: "meter3",
      error: "Invalid Stellar account address format",
    });
  });
});
