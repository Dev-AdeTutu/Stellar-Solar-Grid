/**
 * Integration test: MQTT duplicate message detection (Issue #765)
 *
 * MQTT QoS 1/2 guarantees "at least once" delivery — if the broker never
 * receives our PUBACK/PUBREC (dropped ack, network blip, reconnect
 * mid-flight) it redelivers the same PUBLISH. Without a dedupe gate this
 * causes the same usage reading to be persisted/submitted on-chain twice,
 * double-charging the user.
 *
 * All external I/O is mocked so the suite runs without a live testnet
 * connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ADMIN_SECRET_KEY = "SCZANGBA5RLKN7TLEKQPOXNCMBJGGDFE2WNLO2TZEGEX7IIQGNWWZCPEE";
process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.STELLAR_RPC_URL = "https://mock.rpc.example";
process.env.MQTT_BROKER = "mqtt://localhost:11883";
process.env.USAGE_EVENTS_DB_PATH = ":memory:";
process.env.WEBHOOKS_DB_PATH = ":memory:";

vi.mock("../src/lib/stellar.js", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  const kp = sdk.Keypair.random();
  return {
    CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    server: {
      getLatestLedger: () => Promise.resolve({ sequence: 100 }),
      getEvents: () => Promise.resolve({ events: [] }),
    },
    stellarService: { query: vi.fn(), invoke: vi.fn() },
    adminInvoke: vi.fn().mockResolvedValue("MOCK_TX_HASH"),
    contractQuery: vi.fn(),
    adminKeypair: kp,
    StellarService: class {},
    scrub: (s: string) => s,
  };
});

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn().mockReturnValue({
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      end: vi.fn(),
      options: {},
    }),
  },
}));

const persistAndSubmitUsageEvent = vi.fn().mockResolvedValue({
  id: 1,
  meter_id: "TEST_METER_001",
  on_chain_tx_hash: "MOCK_TX_HASH",
});

vi.mock("../src/lib/usageEvents.js", () => ({
  persistAndSubmitUsageEvent: (...args: unknown[]) => persistAndSubmitUsageEvent(...args),
  insertSubmittedUsageEvents: vi.fn(),
  getKV: vi.fn().mockReturnValue(null),
  setKV: vi.fn(),
  getTypicalWeeklyUsageStroops: vi.fn().mockReturnValue(0),
  initUsageEventStore: vi.fn(),
  startUsageEventRetryWorker: vi.fn(),
  countDeadLetterEvents: vi.fn().mockReturnValue(0),
  getDeadLetterEvents: vi.fn().mockReturnValue({ events: [], total: 0 }),
  requeueDeadLetterEvent: vi.fn(),
}));

import { processMqttMessage } from "../src/iot/bridge.js";

const MOCK_METER_ID = "TEST_METER_001";
const TOPIC = `solargrid/meters/${MOCK_METER_ID}/usage`;

function buildPayload(units: number, cost: number): Buffer {
  return Buffer.from(JSON.stringify({ units, cost }));
}

describe("MQTT duplicate message detection (Issue #765)", () => {
  beforeEach(() => {
    persistAndSubmitUsageEvent.mockClear();
  });

  it("processes a usage message exactly once when the broker redelivers it (QoS 1/2 resend)", async () => {
    const payload = buildPayload(100, 500_000);

    // First delivery — processed normally.
    await processMqttMessage(TOPIC, payload);
    expect(persistAndSubmitUsageEvent).toHaveBeenCalledTimes(1);

    // Broker redelivers the identical PUBLISH (e.g. PUBACK was lost) —
    // must be ignored, not persisted a second time.
    await processMqttMessage(TOPIC, payload);
    expect(persistAndSubmitUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("treats messages with different content as distinct, even on the same topic", async () => {
    await processMqttMessage(TOPIC, buildPayload(111, 555_000));
    await processMqttMessage(TOPIC, buildPayload(222, 999_000));

    expect(persistAndSubmitUsageEvent).toHaveBeenCalledTimes(2);
  });

  it("treats identical payloads on different meter topics as distinct", async () => {
    const payload = buildPayload(333, 111_000);
    await processMqttMessage(`solargrid/meters/METER_A/usage`, payload);
    await processMqttMessage(`solargrid/meters/METER_B/usage`, payload);

    expect(persistAndSubmitUsageEvent).toHaveBeenCalledTimes(2);
  });
});
