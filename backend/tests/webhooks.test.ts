import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";

// requireAdminKey captures ADMIN_API_KEY as a module-level const at import time.
// Static imports are hoisted above plain statements, so this must run via
// vi.hoisted() to actually execute before webhookRouter (and adminAuth) load.
vi.hoisted(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
});

// Mock the stellar module before importing routes to prevent Keypair error
vi.mock("../src/lib/stellar", () => ({
  stellarService: {
    invoke: vi.fn(),
    query: vi.fn(),
    contractId: "C123",
    server: {},
    adminKeypair: {},
    networkPassphrase: "test",
  },
}));

import { webhookRouter } from "../src/routes/webhooks";
import { registerWebhook, getWebhookUrls } from "../src/lib/webhookRegistry";

describe("webhookRouter - POST /api/webhooks/low-balance auth", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;
  let nextMock: any;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    nextMock = vi.fn();

    req = {
      headers: {},
      body: { webhook_url: "https://attacker.example/collect" },
    };
    res = {
      json: jsonMock,
      status: statusMock,
    };

    const urls = getWebhookUrls() as Set<string>;
    urls.clear();
  });

  it("requires requireAdminKey middleware on the route", () => {
    const route = webhookRouter.stack.find(
      (layer: any) => layer.route?.path === "/low-balance" && layer.route?.methods.post
    )?.route;

    expect(route).toBeDefined();
    const middlewareNames = route.stack.map((layer: any) => layer.name);
    expect(middlewareNames).toContain("requireAdminKey");
  });

  it("rejects an unauthenticated request with 401 and does not register the webhook", () => {
    const route = webhookRouter.stack.find(
      (layer: any) => layer.route?.path === "/low-balance" && layer.route?.methods.post
    )?.route;

    const adminKeyLayer = route.stack.find((layer: any) => layer.name === "requireAdminKey");
    expect(adminKeyLayer).toBeDefined();

    adminKeyLayer.handle(req, res, nextMock);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Unauthorized" });
    expect(nextMock).not.toHaveBeenCalled();
    expect(getWebhookUrls().has("https://attacker.example/collect")).toBe(false);
  });
});

describe("webhookRouter - GET /api/webhooks", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    
    req = {};
    res = {
      json: jsonMock,
      status: statusMock,
    };
    
    const urls = getWebhookUrls() as Set<string>;
    urls.clear();
  });

  it("should return empty list when no webhooks are registered", async () => {
    const handler = webhookRouter.stack.find(
      (layer: any) => layer.route?.path === "/" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    if (!handler) {
      throw new Error("GET / endpoint handler not found");
    }

    await handler(req, res);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      webhooks: [],
      count: 0,
    });
  });

  it("should return registered webhooks", async () => {
    registerWebhook("https://example.com/webhook1");
    registerWebhook("https://example.com/webhook2");

    const handler = webhookRouter.stack.find(
      (layer: any) => layer.route?.path === "/" && layer.route?.methods.get
    )?.route?.stack.slice(-1)[0]?.handle;

    await handler(req, res);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      webhooks: ["https://example.com/webhook1", "https://example.com/webhook2"],
      count: 2,
    });
  });
});
