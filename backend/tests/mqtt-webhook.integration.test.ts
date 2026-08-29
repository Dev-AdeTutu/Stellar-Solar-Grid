/**
 * Integration test: MQTT ingest → batch_update_usage → low-balance webhook
 *
 * Covers the platform's core operational flow described in README "Batch Update Flow":
 *   1. A meter usage payload arrives on the MQTT topic
 *   2. The IoT bridge processes it and calls persistAndSubmitUsageEvent
 *   3. When the event is confirmed on-chain, the bridge queries the meter balance
 *   4. When balance < LOW_BALANCE_THRESHOLD the bridge POSTs to all registered webhooks
 *
 * All external I/O is mocked so the suite runs without a live testnet connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Environment stubs ─────────────────────────────────────────────────────────

process.env.ADMIN_SECRET_KEY = "SCZANGBA5RLKN7TLEKQPOXNCMBJGGDFE2WNLO2TZEGEX7IIQGNWWZCPEE";
process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.STELLAR_RPC_URL = "https://mock.rpc.example";
process.env.MQTT_BROKER = "mqtt://localhost:11883";
process.env.LOW_BALANCE_THRESHOLD = "1000000";
process.env.USAGE_EVENTS_DB_PATH = ":memory:";
process.env.WEBHOOKS_DB_PATH = ":memory:";
process.env.PROVIDER_WEBHOOK_URL = "https://legacy-provider.example.com/hook";

// ── Mocks (hoisted before all imports) ───────────────────────────────────────

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
    connect: vi.fn(() => ({
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      end: vi.fn(),
      once: vi.fn(),
      options: { reconnectPeriod: 1000 },
    })),
  },
}));

// Mock usageEvents so persistAndSubmitUsageEvent immediately returns a
// "submitted" record (on_chain_tx_hash set). This makes the bridge proceed to
// call checkAndNotifyLowBalance, which is the code path under test.
vi.mock("../src/lib/usageEvents.js", () => {
  const submittedEvent = {
    id: 1,
    meter_id: "TEST_METER_001",
    units: 100,
    cost: "500000",
    received_at: new Date().toISOString(),
    source_topic: null,
    status: "submitted",
    attempt_count: 1,
    last_attempt_at: new Date().toISOString(),
    last_error: null,
    on_chain_tx_hash: "MOCK_TX_HASH",
    submitted_at: new Date().toISOString(),
  };
  return {
    persistAndSubmitUsageEvent: vi.fn().mockResolvedValue(submittedEvent),
    insertSubmittedUsageEvents: vi.fn(),
    getKV: vi.fn().mockReturnValue(null),
    getTypicalWeeklyUsageStroops: vi.fn().mockReturnValue(0),
    setKV: vi.fn(),
    initUsageEventStore: vi.fn(),
    startUsageEventRetryWorker: vi.fn(),
    countDeadLetterEvents: vi.fn().mockReturnValue(0),
    getDeadLetterEvents: vi.fn().mockReturnValue({ events: [], total: 0 }),
    requeueDeadLetterEvent: vi.fn(),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { processMqttMessage } from "../src/iot/bridge.js";
import { contractQuery } from "../src/lib/stellar.js";
import {
  registerWebhook,
  unregisterWebhook,
  getAllWebhooks,
  getWebhookUrls,
} from "../src/lib/webhookRegistry.js";
import * as StellarSdk from "@stellar/stellar-sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

const MOCK_METER_ID = "TEST_METER_001";
const TOPIC = `solargrid/meters/${MOCK_METER_ID}/usage`;
const PROVIDER_ID = "test-provider";
const LOW_BALANCE = 500_000;    // below 1_000_000 threshold
const HIGH_BALANCE = 5_000_000; // above threshold

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMeterScVal(balance: number) {
  return StellarSdk.nativeToScVal({ balance: BigInt(balance), active: true });
}

function buildPayload(units: number, cost: number): Buffer {
  return Buffer.from(JSON.stringify({ units, cost }));
}

/** Spies on globalThis.fetch to capture webhook POST calls. */
function installFetchSpy() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      let body: unknown = null;
      try { body = JSON.parse((init?.body as string) ?? "null"); } catch { body = init?.body; }
      calls.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  ) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Clears the shared webhook registry so tests don't bleed into each other. */
function clearWebhookRegistry() {
  for (const hook of getAllWebhooks()) {
    unregisterWebhook(hook.provider_id, hook.url);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MQTT → batch_update_usage → webhook (integration)", () => {
  beforeEach(() => {
    clearWebhookRegistry();
    vi.mocked(contractQuery).mockReset();
  });

  it("processes a valid MQTT payload without throwing", async () => {
    vi.mocked(contractQuery).mockResolvedValueOnce(makeMeterScVal(HIGH_BALANCE));
    await expect(
      processMqttMessage(TOPIC, buildPayload(100, 500_000)),
    ).resolves.not.toThrow();
  });

  it("fires a webhook POST when meter balance drops below LOW_BALANCE_THRESHOLD", async () => {
    const WEBHOOK_URL = "https://provider.example.com/webhooks/low-balance";
    registerWebhook(PROVIDER_ID, WEBHOOK_URL);

    vi.mocked(contractQuery).mockResolvedValue(makeMeterScVal(LOW_BALANCE));

    const spy = installFetchSpy();
    try {
      await processMqttMessage(TOPIC, buildPayload(200, 800_000));
      // checkAndNotifyLowBalance is fire-and-forget — give microtasks time to settle
      await new Promise((r) => setTimeout(r, 150));

      const hits = spy.calls.filter((c) => c.url === WEBHOOK_URL);
      expect(hits.length).toBeGreaterThanOrEqual(1);

      const payload = hits[0].body as Record<string, unknown>;
      expect(payload.event).toBe("low_balance");
      expect(payload.meter_id).toBe(MOCK_METER_ID);
      expect(typeof payload.balance).toBe("number");
      expect(typeof payload.threshold).toBe("number");
      expect(typeof payload.timestamp).toBe("string");
      expect(payload.balance as number).toBeLessThanOrEqual(
        Number(process.env.LOW_BALANCE_THRESHOLD),
      );
    } finally {
      spy.restore();
    }
  });

  it("does NOT fire a webhook when balance is above the threshold", async () => {
    const WEBHOOK_URL = "https://provider.example.com/webhooks/high-balance";
    registerWebhook(PROVIDER_ID, WEBHOOK_URL);

    vi.mocked(contractQuery).mockResolvedValueOnce(makeMeterScVal(HIGH_BALANCE));

    const spy = installFetchSpy();
    try {
      await processMqttMessage(TOPIC, buildPayload(50, 100_000));
      await new Promise((r) => setTimeout(r, 150));

      expect(spy.calls.filter((c) => c.url === WEBHOOK_URL).length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it("fires webhooks to ALL registered URLs when balance is low", async () => {
    const URL_A = "https://a.example.com/hook";
    const URL_B = "https://b.example.com/hook";
    registerWebhook(PROVIDER_ID, URL_A);
    registerWebhook(PROVIDER_ID, URL_B);

    vi.mocked(contractQuery).mockResolvedValue(makeMeterScVal(LOW_BALANCE));

    const spy = installFetchSpy();
    try {
      await processMqttMessage(TOPIC, buildPayload(100, 300_000));
      await new Promise((r) => setTimeout(r, 150));

      expect(spy.calls.filter((c) => c.url === URL_A).length).toBeGreaterThanOrEqual(1);
      expect(spy.calls.filter((c) => c.url === URL_B).length).toBeGreaterThanOrEqual(1);
    } finally {
      spy.restore();
    }
  });

  it("handles malformed MQTT JSON gracefully without throwing", async () => {
    await expect(
      processMqttMessage(TOPIC, Buffer.from("not-valid-json")),
    ).resolves.not.toThrow();
  });

  it("handles schema-invalid payload (missing 'units') gracefully without throwing", async () => {
    await expect(
      processMqttMessage(TOPIC, Buffer.from(JSON.stringify({ cost: 500_000 }))),
    ).resolves.not.toThrow();
  });
});

// ── Webhook registry unit ─────────────────────────────────────────────────────

describe("webhook registry", () => {
  beforeEach(clearWebhookRegistry);

  it("registerWebhook adds URL to the registry", () => {
    registerWebhook(PROVIDER_ID, "https://example.com/wh");
    expect(getWebhookUrls().has("https://example.com/wh")).toBe(true);
  });

  it("registerWebhook is idempotent (no duplicates)", () => {
    registerWebhook(PROVIDER_ID, "https://example.com/wh");
    registerWebhook(PROVIDER_ID, "https://example.com/wh");
    expect(getWebhookUrls().size).toBe(1);
  });
});
