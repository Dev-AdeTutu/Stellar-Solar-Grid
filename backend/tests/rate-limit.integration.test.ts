import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  createPayerRateLimiter,
  extractPayerAddress,
  MemoryPayerRateLimitStore,
} from "../src/middleware/payerRateLimit.js";

function request(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    body,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function response() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

async function invoke(
  middleware: ReturnType<typeof createPayerRateLimiter>,
  req: Request,
  res: Response,
) {
  const next = vi.fn() as unknown as NextFunction;
  await middleware(req, res, next);
  return next as unknown as ReturnType<typeof vi.fn>;
}

describe("payer-aware rate limiting", () => {
  it("allows 50 requests per payer and rejects the 51st with retry headers", async () => {
    const middleware = createPayerRateLimiter(new MemoryPayerRateLimitStore());
    const payer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const req = request({ payer });

    for (let i = 0; i < 50; i += 1) {
      const res = response();
      const next = await invoke(middleware, req, res);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }

    const limitedResponse = response();
    const next = await invoke(middleware, req, limitedResponse);
    expect(next).not.toHaveBeenCalled();
    expect(limitedResponse.status).toHaveBeenCalledWith(429);
    expect(limitedResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RATE_LIMITED", retryAfter: expect.any(Number) }),
    );
    expect(limitedResponse.setHeader).toHaveBeenCalledWith("RateLimit-Limit", "50");
    expect(limitedResponse.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", "0");
    expect(limitedResponse.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("keeps payer buckets independent and bypasses payer counting for anonymous requests", async () => {
    const middleware = createPayerRateLimiter(new MemoryPayerRateLimitStore());
    const payerA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const payerB = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWIG";

    for (let i = 0; i < 50; i += 1) {
      await invoke(middleware, request({ payer: payerA }), response());
    }

    const payerBResponse = response();
    const payerBNext = await invoke(middleware, request({ payer: payerB }), payerBResponse);
    expect(payerBNext).toHaveBeenCalledOnce();

    const anonymousResponse = response();
    const anonymousNext = await invoke(middleware, request(), anonymousResponse);
    expect(anonymousNext).toHaveBeenCalledOnce();
    expect(anonymousResponse.status).not.toHaveBeenCalled();
  });

  it("extracts payer, owner, and explicit header identities after JSON parsing", () => {
    const payer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    expect(extractPayerAddress(request({ payer }))).toBe(payer);
    expect(extractPayerAddress(request({ owner: payer }))).toBe(payer);
    expect(extractPayerAddress(request({}, { "x-payer-address": payer }))).toBe(payer);
    expect(extractPayerAddress(request({ payer: "   " }))).toBeNull();
  });
});
