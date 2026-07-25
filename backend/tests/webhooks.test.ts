import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";

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
