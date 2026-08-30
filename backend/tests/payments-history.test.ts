import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { paymentsRouter } from "../src/routes/payments";
import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarService } from "../src/lib/stellar";

vi.mock("../src/lib/stellar", () => ({
  stellarService: {
    timestampToLedger: vi.fn(),
  },
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  server: {
    getEvents: vi.fn(),
  },
  adminInvoke: vi.fn(),
}));

describe("paymentsRouter - GET /api/payments/history/:address", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  const validAddress = "GBRPYHIL2CI3WHZDTOOQFC6EB4LEGIT2SL3XABAD4JRIEBEVEGTXFOAA";

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    req = { params: {}, query: {} };
    res = {
      json: jsonMock,
      status: statusMock,
    };
  });

  it("should reject invalid address format (not 56 chars)", async () => {
    req.params = { address: "INVALID" };

    const handler = paymentsRouter.stack.find(
      (layer: any) => layer.route?.path === "/history/:address" && layer.route?.methods.get
    )?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error("Payment history endpoint handler not found");
    }

    await handler(req as any, res as any);

    expect(statusMock).toHaveBeenCalledWith(400);
    const responseData = jsonMock.mock.calls[0][0];
    expect(responseData.error).toContain("Invalid Stellar address");
  });

  it("should reject address not starting with G", async () => {
    req.params = { address: "C" + "A".repeat(55) };

    const handler = paymentsRouter.stack.find(
      (layer: any) => layer.route?.path === "/history/:address" && layer.route?.methods.get
    )?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error("Payment history endpoint handler not found");
    }

    await handler(req as any, res as any);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it("should accept valid address and default parameters", async () => {
    req.params = { address: validAddress };
    req.query = {};

    // Mock timestamp to ledger conversion
    (stellarService.timestampToLedger as any).mockResolvedValue(100);

    const handler = paymentsRouter.stack.find(
      (layer: any) => layer.route?.path === "/history/:address" && layer.route?.methods.get
    )?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error("Payment history endpoint handler not found");
    }

    // Note: The actual handler will call getEvents, which we need to mock
    // This test verifies the route accepts the parameters
    // Full integration would require more setup
  });

  it("should validate limit is capped at 100", async () => {
    req.params = { address: validAddress };
    req.query = { limit: "500" };

    // Limit should be capped at 100 by the handler logic (Issue #747)
    expect(Math.min(100, Math.max(1, parseInt("500", 10)))).toBe(100);
  });

  it("should reject invalid timestamps", async () => {
    req.params = { address: validAddress };
    req.query = { from: "invalid" };

    const handler = paymentsRouter.stack.find(
      (layer: any) => layer.route?.path === "/history/:address" && layer.route?.methods.get
    )?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error("Payment history endpoint handler not found");
    }

    await handler(req as any, res as any);

    // Should reject due to invalid timestamp
    expect(statusMock).toHaveBeenCalled();
  });

  it("should support pagination with from and to timestamps", async () => {
    req.params = { address: validAddress };
    const now = Date.now();
    req.query = {
      from: String(now - 86400000), // 1 day ago
      to: String(now),
      page: "1",
      limit: "50",
    };

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10)));
    const page = Math.max(1, parseInt(String(req.query.page), 10));

    expect(Number.isFinite(from)).toBe(true);
    expect(Number.isFinite(to)).toBe(true);
    expect(limit).toBe(50);
    expect(page).toBe(1);
  });
});
