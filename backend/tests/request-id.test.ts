import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import requestLogger from "../src/middleware/requestLogger";
import { getReqId } from "../src/lib/requestContext";

describe("requestLogger middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let nextMock: any;
  let headersMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    headersMock = {};
    req = {
      headers: {},
      method: "GET",
      path: "/test",
    };
    res = {
      setHeader: vi.fn((name, value) => {
        headersMock[name] = value;
      }) as any,
    };
    nextMock = vi.fn();
  });

  it("should generate a randomUUID if X-Request-ID header is missing", () => {
    requestLogger(req as Request, res as Response, () => {
      expect((req as any).reqId).toBeDefined();
      expect(headersMock["X-Request-ID"]).toBe((req as any).reqId);
      expect(getReqId()).toBe((req as any).reqId);
      nextMock();
    });

    expect(nextMock).toHaveBeenCalled();
  });

  it("should reuse X-Request-ID header if present", () => {
    const existingId = "existing-uuid-12345";
    req.headers!["x-request-id"] = existingId;

    requestLogger(req as Request, res as Response, () => {
      expect((req as any).reqId).toBe(existingId);
      expect(headersMock["X-Request-ID"]).toBe(existingId);
      expect(getReqId()).toBe(existingId);
      nextMock();
    });

    expect(nextMock).toHaveBeenCalled();
  });
});
