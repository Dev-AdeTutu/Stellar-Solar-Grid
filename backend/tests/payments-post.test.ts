/**
 * Tests for POST /api/payments idempotency-key support (issue #523).
 *
 * We test the idempotency middleware directly — no Stellar SDK, no network.
 * Each test clears the shared store and in-flight set so cases are isolated.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { idempotency, _idempotencyStore, _idempotencyInFlight } from "../src/middleware/idempotency.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Express-like Request mock. */
function makeReq(idempotencyKey?: string, path = "/", baseUrl = "/api/payments"): Partial<Request> {
  return {
    headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    path,
    baseUrl,
  };
}

/** Build a spy-based Response mock that tracks status + json calls. */
function makeRes() {
  const res: any = { statusCode: 200 };

  // Simulate Express's res.status() chaining
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });

  // res.json captures the body and calls through so middleware can intercept
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  });

  // Minimal EventEmitter stub — idempotency middleware calls res.on("finish")
  const listeners: Record<string, Array<() => void>> = {};
  res._listeners = listeners;
  res.on = vi.fn((event: string, cb: () => void) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
    return res;
  });
  res.emit = (event: string) => {
    (listeners[event] ?? []).forEach((cb: () => void) => cb());
  };

  return res;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _idempotencyStore.clear();
  _idempotencyInFlight.clear();
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe("idempotency middleware", () => {
  describe("pass-through when no header present", () => {
    it("calls next() immediately when Idempotency-Key header is absent", () => {
      const middleware = idempotency();
      const req = makeReq(undefined);
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledOnce();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("calls next() when Idempotency-Key is an empty string", () => {
      const middleware = idempotency();
      const req = makeReq("   "); // whitespace-only
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe("first request — fresh key", () => {
    it("calls next() and does not immediately respond", () => {
      const middleware = idempotency();
      const req = makeReq("key-abc-123");
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledOnce();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("caches a 200 response after the handler calls res.json", () => {
      const middleware = idempotency();
      const req = makeReq("key-new-1");
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      // Simulate the handler responding
      res.json({ hash: "abc123" });

      expect(_idempotencyStore.size).toBe(1);
    });

    it("caches a 400 validation-error response (non-5xx)", () => {
      const middleware = idempotency();
      const req = makeReq("key-bad-req");
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      res.statusCode = 400;
      res.json({ error: "Invalid request", code: "VALIDATION_ERROR" });

      expect(_idempotencyStore.size).toBe(1);
    });

    it("does NOT cache a 500 server-error response", () => {
      const middleware = idempotency();
      const req = makeReq("key-server-err");
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      res.statusCode = 500;
      res.json({ error: "Internal server error" });

      expect(_idempotencyStore.size).toBe(0);
    });

    it("does NOT cache a 502 bad-gateway response", () => {
      const middleware = idempotency();
      const req = makeReq("key-502");
      const res = makeRes();
      const next = vi.fn();

      middleware(req as Request, res as Response, next as NextFunction);

      res.statusCode = 502;
      res.json({ error: "RPC request failed", code: "RPC_ERROR" });

      expect(_idempotencyStore.size).toBe(0);
    });
  });

  describe("duplicate key — replay cached response", () => {
    it("returns the cached body without calling next() on the second request", () => {
      const middleware = idempotency();
      const KEY = "key-dup-1";

      // First request — populates cache
      const req1 = makeReq(KEY);
      const res1 = makeRes();
      const next1 = vi.fn();
      middleware(req1 as Request, res1 as Response, next1 as NextFunction);
      res1.json({ hash: "tx-hash-xyz" });

      // Second request with identical key
      const req2 = makeReq(KEY);
      const res2 = makeRes();
      const next2 = vi.fn();
      middleware(req2 as Request, res2 as Response, next2 as NextFunction);

      // Handler must NOT be called again
      expect(next2).not.toHaveBeenCalled();
      // Replayed body must match the original
      expect(res2.json).toHaveBeenCalledWith({ hash: "tx-hash-xyz" });
    });

    it("sets X-Idempotent-Replayed: true on replay", () => {
      const middleware = idempotency();
      const KEY = "key-replay-header";

      // Seed the cache manually to keep the test self-contained
      const req1 = makeReq(KEY);
      const res1 = makeRes();
      middleware(req1 as Request, res1 as Response, vi.fn() as NextFunction);
      res1.json({ hash: "replay-hash" });

      // Track setHeader calls on the replay response
      const req2 = makeReq(KEY);
      const res2 = makeRes();
      res2.setHeader = vi.fn();
      middleware(req2 as Request, res2 as Response, vi.fn() as NextFunction);

      expect(res2.setHeader).toHaveBeenCalledWith("X-Idempotent-Replayed", "true");
    });

    it("replays the original status code", () => {
      const middleware = idempotency();
      const KEY = "key-status-replay";

      const req1 = makeReq(KEY);
      const res1 = makeRes();
      middleware(req1 as Request, res1 as Response, vi.fn() as NextFunction);
      res1.statusCode = 400;
      res1.json({ error: "Invalid request", code: "VALIDATION_ERROR" });

      const req2 = makeReq(KEY);
      const res2 = makeRes();
      middleware(req2 as Request, res2 as Response, vi.fn() as NextFunction);

      expect(res2.status).toHaveBeenCalledWith(400);
    });
  });

  describe("concurrent in-flight dedup", () => {
    it("returns 409 IDEMPOTENCY_CONFLICT when the same key is already in-flight", () => {
      const middleware = idempotency();
      const KEY = "key-inflight-1";

      // First request starts, handler has not yet responded (res.json not called)
      const req1 = makeReq(KEY);
      const res1 = makeRes();
      middleware(req1 as Request, res1 as Response, vi.fn() as NextFunction);

      // Second concurrent request with same key
      const req2 = makeReq(KEY);
      const res2 = makeRes();
      const next2 = vi.fn();
      middleware(req2 as Request, res2 as Response, next2 as NextFunction);

      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(409);
      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
      );
    });

    it("clears in-flight on finish even if res.json is never called", () => {
      const middleware = idempotency();
      const KEY = "key-finish-cleanup";

      const req1 = makeReq(KEY);
      const res1 = makeRes();
      middleware(req1 as Request, res1 as Response, vi.fn() as NextFunction);

      // Simulate the response finishing (e.g. error middleware called res.end)
      res1.emit("finish");

      // Now the key should no longer be in-flight
      expect(_idempotencyInFlight.has).toBeDefined();

      // A new request should go through, not be blocked
      const req2 = makeReq(KEY);
      const res2 = makeRes();
      const next2 = vi.fn();
      middleware(req2 as Request, res2 as Response, next2 as NextFunction);

      expect(next2).toHaveBeenCalledOnce();
    });
  });

  describe("key isolation across routes", () => {
    it("treats the same Idempotency-Key on different routes as independent entries", () => {
      const KEY = "key-cross-route";

      // Request on /api/payments
      const middlewareA = idempotency();
      const reqA = makeReq(KEY, "/", "/api/payments");
      const resA = makeRes();
      middlewareA(reqA as Request, resA as Response, vi.fn() as NextFunction);
      resA.json({ hash: "payments-hash" });

      // Request on /api/collaborators with the same key
      const middlewareB = idempotency();
      const reqB = makeReq(KEY, "/", "/api/collaborators");
      const resB = makeRes();
      const nextB = vi.fn();
      middlewareB(reqB as Request, resB as Response, nextB as NextFunction);

      // Should NOT be a cache hit — different route
      expect(nextB).toHaveBeenCalledOnce();
      expect(resB.json).not.toHaveBeenCalled();
    });
  });

  describe("TTL expiry", () => {
    it("treats an expired entry as a cache miss and calls next()", () => {
      const KEY = "key-expired";

      // Derive the same store key the middleware will compute
      const sk = createHash("sha256")
        .update(KEY)
        .update("|")
        .update("/api/payments/")
        .digest("hex");

      _idempotencyStore.set(sk, {
        status: 200,
        body: { hash: "old-hash" },
        expiresAt: Date.now() - 1, // already expired
      });

      const middleware = idempotency();
      const req = makeReq(KEY, "/", "/api/payments");
      const res = makeRes();
      const next = vi.fn();
      middleware(req as Request, res as Response, next as NextFunction);

      // Expired entry = cache miss, handler should run
      expect(next).toHaveBeenCalledOnce();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
