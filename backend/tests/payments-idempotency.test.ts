import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { paymentsRouter } from "../src/routes/payments";
import { adminInvoke } from "../src/lib/stellar";

vi.mock("../src/lib/stellar", () => ({
  stellarService: {},
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  server: {},
  adminInvoke: vi.fn(),
}));

describe("paymentsRouter - POST /api/payments idempotency", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  const validPayer = "GBRPYHIL2CI3WHZDTOOQFC6EB4LEGIT2SL3XABAD4JRIEBEVEGTXFOAA";

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    req = {
      headers: {},
      body: {
        meterId: "METER1",
        amount: 5000000,
        payer: validPayer,
      },
    };
    res = {
      json: jsonMock,
      status: statusMock,
    };
  });

  const getPostHandler = () => {
    const layer = paymentsRouter.stack.find(
      (l: any) => l.route?.path === "/" && l.route?.methods.post,
    );
    if (!layer) throw new Error("POST / handler not found");
    return layer.route.stack[0].handle;
  };

  it("should process payment and cache response when Idempotency-Key header is provided", async () => {
    (adminInvoke as any).mockResolvedValueOnce("txhash_12345");
    const handler = getPostHandler();

    req.headers = { "idempotency-key": "test-key-001" };

    await handler(req as any, res as any, () => {});

    expect(adminInvoke).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({ hash: "txhash_12345" });

    // Second call with same Idempotency-Key should return cached response without calling adminInvoke again
    vi.clearAllMocks();
    req.headers = { "idempotency-key": "test-key-001" };

    await handler(req as any, res as any, () => {});

    expect(adminInvoke).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith({ hash: "txhash_12345" });
  });

  it("should execute contract invocation for every call when no Idempotency-Key is provided", async () => {
    (adminInvoke as any).mockResolvedValue("txhash_99999");
    const handler = getPostHandler();

    req.headers = {};

    await handler(req as any, res as any, () => {});
    expect(adminInvoke).toHaveBeenCalledTimes(1);

    await handler(req as any, res as any, () => {});
    expect(adminInvoke).toHaveBeenCalledTimes(2);
  });
});
