import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import express from "express";
import requestLogger from "../src/middleware/requestLogger";
import { getReqId } from "../src/lib/requestContext";

// ── Unit tests: middleware in isolation ───────────────────────────────────────────────

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

// ── Integration tests: X-Request-ID flows end-to-end ──────────────────────────────

/**
 * Minimal in-process Express app that exercises the full middleware stack:
 *   requestLogger → route handler → global error handler
 *
 * No network required — all tests run in-process using Node's http module.
 */
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);

  // 200 OK route
  app.get("/ok", (_req, res) => {
    res.json({ message: "ok" });
  });

  // 400 Bad Request route
  app.get("/bad", (_req, res) => {
    res.status(400).json({ error: "bad request", code: "BAD_REQUEST", requestId: getReqId() });
  });

  // 500 error route (throws so the error handler fires)
  app.get("/boom", () => {
    throw new Error("intentional");
  });

  // Global error handler — mirrors index.ts pattern
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({
      error: err.message || "Internal server error",
      code: "INTERNAL_ERROR",
      requestId: getReqId(),
    });
  });

  return app;
}

/**
 * Tiny helper: make an in-process HTTP request without needing supertest.
 * Returns { status, headers, body }.
 */
async function inProcessRequest(
  app: ReturnType<typeof express>,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const opts = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...extraHeaders },
      };
      const reqHttp = http.request(opts, (res: any) => {
        let raw = "";
        res.on("data", (chunk: any) => (raw += chunk));
        res.on("end", () => {
          server.close();
          let body: any;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers as Record<string, string>,
            body,
          });
        });
      });
      reqHttp.on("error", (err: any) => {
        server.close();
        reject(err);
      });
      reqHttp.end();
    });
  });
}

describe("X-Request-ID correlation — integration", () => {
  const app = buildTestApp();

  it("2xx response includes X-Request-ID header", async () => {
    const { status, headers } = await inProcessRequest(app, "GET", "/ok");
    expect(status).toBe(200);
    expect(headers["x-request-id"]).toBeDefined();
    expect(typeof headers["x-request-id"]).toBe("string");
    expect(headers["x-request-id"].length).toBeGreaterThan(0);
  });

  it("caller-supplied X-Request-ID is echoed back on 2xx", async () => {
    const myId = "caller-supplied-abc-123";
    const { status, headers } = await inProcessRequest(app, "GET", "/ok", {
      "x-request-id": myId,
    });
    expect(status).toBe(200);
    expect(headers["x-request-id"]).toBe(myId);
  });

  it("4xx response includes X-Request-ID header", async () => {
    const { status, headers, body } = await inProcessRequest(app, "GET", "/bad");
    expect(status).toBe(400);
    expect(headers["x-request-id"]).toBeDefined();
    // requestId in body matches the header value
    expect(body.requestId).toBe(headers["x-request-id"]);
  });

  it("caller-supplied X-Request-ID propagates to 4xx error response body", async () => {
    const myId = "trace-id-for-4xx";
    const { status, headers, body } = await inProcessRequest(app, "GET", "/bad", {
      "x-request-id": myId,
    });
    expect(status).toBe(400);
    expect(headers["x-request-id"]).toBe(myId);
    expect(body.requestId).toBe(myId);
  });

  it("5xx error handler includes X-Request-ID header and requestId in body", async () => {
    const { status, headers, body } = await inProcessRequest(app, "GET", "/boom");
    expect(status).toBe(500);
    expect(headers["x-request-id"]).toBeDefined();
    expect(body.requestId).toBe(headers["x-request-id"]);
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("caller-supplied X-Request-ID propagates to 5xx error response body", async () => {
    const myId = "trace-id-for-500";
    const { status, headers, body } = await inProcessRequest(app, "GET", "/boom", {
      "x-request-id": myId,
    });
    expect(status).toBe(500);
    expect(headers["x-request-id"]).toBe(myId);
    expect(body.requestId).toBe(myId);
  });

  it("each request gets a unique X-Request-ID when none is supplied", async () => {
    const [r1, r2] = await Promise.all([
      inProcessRequest(app, "GET", "/ok"),
      inProcessRequest(app, "GET", "/ok"),
    ]);
    expect(r1.headers["x-request-id"]).toBeDefined();
    expect(r2.headers["x-request-id"]).toBeDefined();
    expect(r1.headers["x-request-id"]).not.toBe(r2.headers["x-request-id"]);
  });
});
