import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { NextFunction, Request, Response } from "express";
import * as OpenApiValidator from "express-openapi-validator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Exercises the express-openapi-validator wiring (closes #759) against the
 * real openapi.yaml, using a minimal stand-in app instead of booting the
 * full server (which requires a live Stellar RPC / MQTT broker).
 */
describe("OpenAPI request validation", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(__dirname, "../openapi.yaml"),
        validateRequests: true,
        validateResponses: false,
        ignoreUndocumented: true,
      }),
    );

    app.post("/api/meters/bulk", (_req, res) => {
      res.json({ meters: [], errors: {}, count: 0, requested: 0 });
    });

    app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: "Route not found", code: "NOT_FOUND" });
    });

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      if (Array.isArray(err.errors)) {
        return res.status(err.status || 400).json({
          error: "Validation failed",
          code: "VALIDATION_ERROR",
          details: err.errors,
        });
      }
      res.status(err.status || 500).json({ error: err.message || "Internal error" });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("rejects a documented endpoint's request missing a required field with a structured 400", async () => {
    const res = await fetch(`${baseUrl}/api/meters/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("rejects a request that violates a field constraint (maxItems)", async () => {
    const res = await fetch(`${baseUrl}/api/meters/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meter_ids: Array.from({ length: 101 }, (_, i) => `m${i}`) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("passes a well-formed request through to the route handler", async () => {
    const res = await fetch(`${baseUrl}/api/meters/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meter_ids: ["meter-1"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ count: 0, requested: 0 });
  });

  it("leaves routes not documented in the spec unvalidated (ignoreUndocumented)", async () => {
    const res = await fetch(`${baseUrl}/api/not-in-spec`, { method: "GET" });
    // Falls through to the app's own 404 handler rather than a validator error.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});
