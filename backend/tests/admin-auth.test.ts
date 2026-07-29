import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import { adminAuth } from "../src/lib/adminAuth.js";

describe("adminAuth middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let nextMock: any;
  let jsonMock: any;
  let statusMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Clear the env var initially
    delete process.env.ADMIN_API_KEY;

    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    nextMock = vi.fn();

    req = {
      headers: {},
      method: "POST",
      path: "/test",
    };
    res = {
      status: statusMock,
      json: jsonMock,
    };
  });

  it("should return 503 if ADMIN_API_KEY is not set", () => {
    adminAuth(req as Request, res as Response, nextMock);

    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Server misconfiguration",
      code: "MISCONFIGURED",
    });
    expect(nextMock).not.toHaveBeenCalled();
  });

  it("should return 401 if ADMIN_API_KEY is set but credentials are missing", () => {
    process.env.ADMIN_API_KEY = "test-secret-key";

    adminAuth(req as Request, res as Response, nextMock);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
    expect(nextMock).not.toHaveBeenCalled();
  });

  it("should call next() if valid Bearer token is provided", () => {
    process.env.ADMIN_API_KEY = "test-secret-key";
    req.headers!.authorization = "Bearer test-secret-key";

    adminAuth(req as Request, res as Response, nextMock);

    expect(nextMock).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should call next() if valid X-Admin-Key header is provided", () => {
    process.env.ADMIN_API_KEY = "test-secret-key";
    req.headers!["x-admin-key"] = "test-secret-key";

    adminAuth(req as Request, res as Response, nextMock);

    expect(nextMock).toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("should return 401 if invalid token is provided", () => {
    process.env.ADMIN_API_KEY = "test-secret-key";
    req.headers!.authorization = "Bearer wrong-key";

    adminAuth(req as Request, res as Response, nextMock);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
    expect(nextMock).not.toHaveBeenCalled();
  });
});
