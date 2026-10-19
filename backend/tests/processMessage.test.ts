/**
 * Unit tests for processMqttMessage — covers MqttPayloadSchema validation.
 *
 * All contract / Stellar SDK calls are stubbed so the tests are fully offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stub heavy dependencies before importing the module under test ────────────

vi.mock("../src/lib/usageEvents.js", () => ({
  persistAndSubmitUsageEvent: vi.fn().mockResolvedValue({ id: 1, on_chain_tx_hash: "abc123" }),
  insertSubmittedUsageEvents: vi.fn(),
  getKV: vi.fn().mockReturnValue(null),
  setKV: vi.fn(),
}));

vi.mock("../src/lib/webhookRegistry.js", () => ({
  getWebhookUrls: vi.fn().mockReturnValue(new Set()),
  fireWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/stellar.js", () => ({
  adminInvoke: vi.fn().mockResolvedValue("stub-tx-hash"),
  contractQuery: vi.fn().mockResolvedValue(null),
  server: { getLatestLedger: vi.fn(), getEvents: vi.fn() },
  CONTRACT_ID: "CTEST",
}));

vi.mock("../src/lib/metrics.js", () => ({
  mqttMessages: { inc: vi.fn() },
  activeMeters: { set: vi.fn() },
  paymentVolume: { inc: vi.fn() },
}));

vi.mock("mqtt", () => ({
  default: { connect: vi.fn().mockReturnValue({ on: vi.fn(), subscribe: vi.fn(), publish: vi.fn(), end: vi.fn() }) },
}));

// Spy on logger.error to assert it is called with structured fields
const loggerErrorSpy = vi.fn();
vi.mock("../src/lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
    fatal: vi.fn(),
  },
}));

// ── Import module under test ───────────────────────────────────────────────────

import { processMqttMessage } from "../src/iot/bridge.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOPIC = "solargrid/meters/METER1/usage";

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("processMqttMessage — MqttPayloadSchema validation", () => {
  beforeEach(() => {
    loggerErrorSpy.mockClear();
  });

  it("accepts a valid payload { units, cost } (meterId comes from topic)", async () => {
    await processMqttMessage(TOPIC, buf({ units: 100, cost: 500000 }));
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it("rejects and logs when JSON is malformed (not parseable)", async () => {
    await processMqttMessage(TOPIC, Buffer.from("not-json"));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
    const [msg] = loggerErrorSpy.mock.calls[0] as [string];
    expect(msg).toMatch(/malformed/i);
  });

  it("rejects payload missing units and logs a structured error", async () => {
    await processMqttMessage(TOPIC, buf({ cost: 500000 }));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
    const [msg, meta] = loggerErrorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/schema validation failed/i);
    expect(meta).toHaveProperty("errors");
    expect(meta).toHaveProperty("event", "mqtt_payload_invalid");
  });

  it("rejects payload missing cost and logs a structured error", async () => {
    await processMqttMessage(TOPIC, buf({ units: 100 }));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
    const [, meta] = loggerErrorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toHaveProperty("errors");
  });

  it("rejects payload where units is not a positive integer", async () => {
    await processMqttMessage(TOPIC, buf({ units: -5, cost: 500000 }));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
    const [, meta] = loggerErrorSpy.mock.calls[0] as [string, Record<string, unknown>];
    const errors = meta.errors as Record<string, string[]>;
    expect(errors).toHaveProperty("units");
  });

  it("rejects payload where cost is a float (non-integer)", async () => {
    await processMqttMessage(TOPIC, buf({ units: 100, cost: 1.5 }));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
    const [, meta] = loggerErrorSpy.mock.calls[0] as [string, Record<string, unknown>];
    const errors = meta.errors as Record<string, string[]>;
    expect(errors).toHaveProperty("cost");
  });

  it("rejects payload with unknown extra fields (strict schema)", async () => {
    await processMqttMessage(TOPIC, buf({ units: 100, cost: 500000, extraField: "bad" }));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
  });

  it("rejects payload when meterId from topic is empty string", async () => {
    // topic with no meterId segment produces an empty string
    await processMqttMessage("solargrid/meters//usage", buf({ units: 100, cost: 500000 }));
    expect(loggerErrorSpy).toHaveBeenCalledOnce();
    const [, meta] = loggerErrorSpy.mock.calls[0] as [string, Record<string, unknown>];
    const errors = meta.errors as Record<string, string[]>;
    expect(errors).toHaveProperty("meterId");
  });
});
