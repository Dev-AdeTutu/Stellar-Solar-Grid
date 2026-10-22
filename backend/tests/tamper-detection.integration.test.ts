import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `solargrid-tamper-${process.pid}.sqlite`);
process.env.TAMPER_DB_PATH = dbPath;
process.env.WEBHOOKS_DB_PATH = ":memory:";
process.env.ADMIN_SECRET_KEY = "SCZANGBA5RLKN7TLEKQPOXNCMBJGGDFE2WNLO2TZEGEX7IIQGNWWZCPEE";
process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.STELLAR_RPC_URL = "https://mock.rpc.example";

const mocks = vi.hoisted(() => ({
  adminInvoke: vi.fn().mockResolvedValue("TAMPER_TX"),
  publish: vi.fn(),
  fireWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/stellar.js", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  return {
    adminInvoke: mocks.adminInvoke,
    contractQuery: vi.fn(),
    adminKeypair: sdk.Keypair.random(),
    CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    server: {},
    stellarService: { query: vi.fn(), invoke: vi.fn() },
    StellarService: class {},
  };
});
vi.mock("../src/iot/mqttClient.js", () => ({ getMqttClient: () => ({ publish: mocks.publish }) }));
vi.mock("../src/lib/webhookRegistry.js", () => ({
  getWebhookUrls: vi.fn(() => new Set(["https://provider.example/tamper"])),
  fireWebhook: mocks.fireWebhook,
}));

import { processTamperEvent } from "../src/lib/tamperDetection.js";
import { closeTamperStore, getTamperHistory } from "../src/lib/tamperDetection.js";

const topic = "solargrid/meters/METER-TAMPER-1/tamper";

describe("meter tamper MQTT processing (#966)", () => {
  beforeEach(() => {
    closeTamperStore();
    try { fs.unlinkSync(dbPath); } catch { /* test database may not exist */ }
    vi.clearAllMocks();
    mocks.adminInvoke.mockResolvedValue("TAMPER_TX");
  });

  it("records timestamp, disables the meter, sends OFF, and notifies provider", async () => {
    await processTamperEvent("METER-TAMPER-1", Buffer.from(JSON.stringify({
      tamper: true,
      reason: "cover_open",
      timestamp: "2026-01-01T00:00:00Z",
    })), topic);

    expect(mocks.adminInvoke).toHaveBeenCalledWith("set_active", expect.any(Array));
    expect(mocks.publish).toHaveBeenCalledWith(
      "solargrid/meters/METER-TAMPER-1/control",
      expect.stringContaining('"cmd":"OFF"'),
      { qos: 1 },
    );
    expect(mocks.fireWebhook).toHaveBeenCalledWith(
      "https://provider.example/tamper",
      expect.stringContaining('"event":"meter_tamper_detected"'),
    );
    expect(getTamperHistory("METER-TAMPER-1")).toMatchObject([
      { meter_id: "METER-TAMPER-1", detected_at: "2026-01-01T00:00:00.000Z", disabled: 1 },
    ]);
  });

  it("does not duplicate an identical sensor event on MQTT redelivery", async () => {
    const payload = Buffer.from(JSON.stringify({ tamper: true, reason: "cover_open", timestamp: "2026-01-01T00:00:00Z" }));
    await processTamperEvent("METER-TAMPER-1", payload, topic);
    await processTamperEvent("METER-TAMPER-1", payload, topic);
    expect(mocks.adminInvoke).toHaveBeenCalledTimes(1);
    expect(getTamperHistory("METER-TAMPER-1")).toHaveLength(1);
  });
});
