import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { statsRouter, __resetStatsCache } from "../src/routes/stats";
import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarService } from "../src/lib/stellar";

vi.mock("../src/lib/stellar", () => ({
  stellarService: {
    query: vi.fn(),
  },
}));

describe("statsRouter - GET /api/stats", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetStatsCache();

    
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    
    req = {};
    res = {
      json: jsonMock,
      status: statusMock,
    };

    // Clear environment for test
    delete process.env.ADMIN_ADDRESS;
  });

  it("should handle empty meter list without divide-by-zero", async () => {
    // Mock empty meters list
    const mockResult = StellarSdk.nativeToScVal([], { type: "vec" });
    (stellarService.query as any).mockResolvedValue(mockResult);

    // Get the GET / handler
    const handler = statsRouter.stack.find(
      (layer: any) => layer.route?.path === "/" && layer.route?.methods.get
    )?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error("Stats endpoint handler not found");
    }

    await handler(req, res);

    const responseData = jsonMock.mock.calls[0][0];
    
    // Verify no NaN, Infinity, or null values
    expect(responseData.totalMeters).toBe(0);
    expect(responseData.activeMeters).toBe(0);
    expect(responseData.inactiveMeters).toBe(0);
    expect(responseData.totalUnits).toBe(0);
    expect(responseData.avgUnitsPerMeter).toBe(0);
    expect(responseData.totalRevenue).toBe(0);
    expect(responseData.avgRevenue).toBe(0);
    
    // Ensure no NaN or Infinity
    expect(Number.isNaN(responseData.avgUnitsPerMeter)).toBe(false);
    expect(Number.isFinite(responseData.avgUnitsPerMeter)).toBe(true);
    expect(Number.isNaN(responseData.avgRevenue)).toBe(false);
    expect(Number.isFinite(responseData.avgRevenue)).toBe(true);
  });

  it("should calculate averages correctly with meters present", async () => {
    // Mock meters with data
    const mockMeters = [
      { active: true, units_used: 100 },
      { active: false, units_used: 200 },
    ];
    const mockResult = StellarSdk.nativeToScVal(mockMeters, { type: "vec" });
    (stellarService.query as any).mockResolvedValue(mockResult);

    const handler = statsRouter.stack.find(
      (layer: any) => layer.route?.path === "/" && layer.route?.methods.get
    )?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error("Stats endpoint handler not found");
    }

    await handler(req, res);

    const responseData = jsonMock.mock.calls[0][0];
    
    expect(responseData.totalMeters).toBe(2);
    expect(responseData.activeMeters).toBe(1);
    expect(responseData.inactiveMeters).toBe(1);
    expect(responseData.totalUnits).toBe(300);
    expect(responseData.avgUnitsPerMeter).toBe(150); // 300 / 2
  });
});
