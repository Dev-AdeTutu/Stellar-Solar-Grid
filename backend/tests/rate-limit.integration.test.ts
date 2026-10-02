import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  createPayerRateLimiter,
  extractPayerAddress,
  MemoryPayerRateLimitStore,
} from "../src/middleware/payerRateLimit.js";
import {
  createGlobalRateLimiter,
  MemoryRateLimitStore,
} from "../src/middleware/globalRateLimit.js";

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

describe("global rate limiting", () => {
  it("limits every IP and returns remaining and retry headers", async () => {
    const middleware = createGlobalRateLimiter({
      store: new MemoryRateLimitStore(),
      ipLimit: 1,
      windowMs: 60_000,
    });
    const req = request();
    Object.assign(req, { ip: "192.0.2.1", socket: { remoteAddress: "192.0.2.1" } });

    const first = response();
    const firstNext = vi.fn() as unknown as NextFunction;
    await middleware(req, first, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    expect(first.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "0");

    const second = response();
    const secondNext = vi.fn() as unknown as NextFunction;
    await middleware(req, second, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.status).toHaveBeenCalledWith(429);
    expect(second.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RATE_LIMITED", retryAfter: expect.any(Number) }),
    );
    expect(second.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("applies permission-tier quotas independently of IP quotas", async () => {
    const middleware = createGlobalRateLimiter({
      store: new MemoryRateLimitStore(),
      ipLimit: 10,
      windowMs: 60_000,
      userLimits: { read: 1, write: 2, admin: 3 },
      resolveIdentity: () => ({ id: "provider-1", tier: "read" }),
    });
    const req = request();
    Object.assign(req, { ip: "192.0.2.2", socket: { remoteAddress: "192.0.2.2" } });

    const first = response();
    const firstNext = vi.fn() as unknown as NextFunction;
    await middleware(req, first, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();
    expect(first.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit-User", "1");

    const second = response();
    const secondNext = vi.fn() as unknown as NextFunction;
    await middleware(req, second, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.status).toHaveBeenCalledWith(429);
    expect(second.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining-User", "0");
  });
});
