import { describe, expect, beforeEach, it, vi } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const { publish, activeMetersSet } = vi.hoisted(() => ({
  publish: vi.fn(),
  activeMetersSet: vi.fn(),
}));

vi.mock("../src/lib/stellar", () => ({
  server: {
    getLatestLedger: vi.fn(),
    getEvents: vi.fn(),
  },
  CONTRACT_ID: "C123",
  adminInvoke: vi.fn(),
  contractQuery: vi.fn(),
}));

vi.mock("../src/lib/usageEvents", () => ({
  persistAndSubmitUsageEvent: vi.fn(),
  insertSubmittedUsageEvents: vi.fn(),
  getKV: vi.fn(() => null),
  setKV: vi.fn(),
}));

vi.mock("../src/lib/metrics.js", () => ({
  mqttMessages: { inc: vi.fn() },
  activeMeters: { set: activeMetersSet },
  paymentVolume: { inc: vi.fn() },
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  handleContractEvent,
  setMqttClientForTests,
} from "../src/iot/bridge.ts";

describe("bridge limit_hit contract events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMqttClientForTests({ publish } as any);
  });

  it("turns the relay off immediately when the limit_hit event arrives", async () => {
    const meterId = "METER_LIMIT";
    const event = {
      topic: [
        StellarSdk.nativeToScVal("solargrid", { type: "symbol" }),
        StellarSdk.nativeToScVal("limit_hit", { type: "symbol" }),
        StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      ],
      value: StellarSdk.xdr.ScVal.scvVoid(),
    } as any;

    await handleContractEvent(event);

    expect(activeMetersSet).toHaveBeenCalledWith({ meter_id: meterId }, 0);
    expect(publish).toHaveBeenCalledWith(
      `solargrid/meters/${meterId}/control`,
      expect.stringContaining('"cmd":"OFF"'),
      { qos: 1 },
      expect.any(Function),
    );
  });
});
