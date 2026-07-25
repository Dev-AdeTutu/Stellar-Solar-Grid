import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";

// Mock the stellar module before importing routes
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

// Mock the mqttClient module
const mockPublish = vi.fn();
vi.mock("../src/iot/mqttClient.js", () => ({
  getMqttClient: () => ({
    publish: mockPublish,
  }),
}));

import { createMeterRouter } from "../src/routes/meters";
import { stellarService } from "../src/lib/stellar";
import { getMqttClient } from "../src/iot/mqttClient.js";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("metersRouter - POST /api/meters/:id/deactivate", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: any;
  let statusMock: any;
  let router: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    jsonMock = vi.fn().mockReturnValue({});
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    
    req = {
      params: {
        id: "meter123",
      },
      headers: {
        "x-admin-key": "test-admin-key",
      },
    };
    res = {
      json: jsonMock,
      status: statusMock,
    };

    process.env.ADMIN_KEY = "test-admin-key";

    router = createMeterRouter(stellarService);
  });

  it("should deactivate meter and publish MQTT OFF message", async () => {
    (stellarService.query as any).mockResolvedValue(
      StellarSdk.nativeToScVal({ active: true })
    );

    (stellarService.invoke as any).mockResolvedValue("mock-deactivate-tx");

    const handler = router.stack.find(
      (layer: any) => layer.route?.path === "/:id/deactivate" && layer.route?.methods.post
    )?.route?.stack.slice(-1)[0]?.handle;

    if (!handler) {
      throw new Error("Deactivate endpoint handler not found");
    }

    // Call the handler
    handler(req, res, () => {});

    // Wait a short time to allow the async handler promises to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stellarService.query).toHaveBeenCalledWith("get_meter", expect.any(Array));
    expect(stellarService.invoke).toHaveBeenCalledWith("set_active", expect.any(Array));
    
    // Assert on the mock function returned by getMqttClient().publish
    const client = getMqttClient();
    expect(client.publish).toHaveBeenCalledWith(
      "solargrid/meters/meter123/control",
      expect.stringContaining('"cmd":"OFF"'),
      { qos: 1 }
    );

    expect(jsonMock).toHaveBeenCalledWith({
      hash: "mock-deactivate-tx",
      meter_id: "meter123",
      active: false,
    });
  });
});
