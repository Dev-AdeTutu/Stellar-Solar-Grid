/**
 * #1158: a web push subscription whose expirationTime is already past must be refused with a 400,
 * instead of being saved and then failing every later send with 410 Gone.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// On upstream main `src/lib/stellar.ts` imports a `quantumCrypto.js` that does not exist, so anything
// that reaches it fails to load. The push route does not use it.
vi.mock("../src/lib/stellar.js", () => ({}));
// `src/lib/auditTrail.ts` also has a leftover merge-conflict marker on upstream main.
vi.mock("../src/lib/auditTrail.js", () => ({ recordAudit: vi.fn() }));

process.env.USAGE_EVENTS_DB_PATH = ":memory:";

const { pushSubscriptionsRouter } = await import("../src/routes/pushSubscriptions.js");
const { listPushSubscriptionsByOwner } = await import("../src/lib/pushSubscriptions.js");
const { closeUsageEventStore, initUsageEventStore } = await import("../src/lib/usageEvents.js");

let server: Server;
let baseUrl = "";
const owner = `G${"A".repeat(55)}`;
let seq = 0;

const body = (expirationTime?: number | null) => ({
  ownerAddress: owner,
  subscription: {
    endpoint: `https://push.example.com/send/${(seq += 1)}`,
    ...(expirationTime === undefined ? {} : { expirationTime }),
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
  },
});

async function subscribe(payload: unknown) {
  const res = await fetch(`${baseUrl}/api/push/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
}

const stored = () => listPushSubscriptionsByOwner(owner).length;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/push", pushSubscriptionsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeUsageEventStore();
});

beforeEach(() => {
  listPushSubscriptionsByOwner(owner); // the table is created on first use
  initUsageEventStore().exec("DELETE FROM push_subscriptions");
});

describe("POST /api/push/subscribe with expirationTime", () => {
  it("rejects a subscription that expired in the past, and stores nothing", async () => {
    const res = await subscribe(body(Date.now() - 60_000));

    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/expired/i);
    expect(stored()).toBe(0);
  });

  it("rejects one that expires exactly now", async () => {
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      expect((await subscribe(body(1_700_000_000_000))).status).toBe(400);
    } finally {
      Date.now = realNow;
    }
    expect(stored()).toBe(0);
  });

  it("rejects the epoch and negative values", async () => {
    expect((await subscribe(body(0))).status).toBe(400);
    expect((await subscribe(body(-1))).status).toBe(400);
    expect(stored()).toBe(0);
  });

  it("accepts a subscription that expires in the future", async () => {
    const res = await subscribe(body(Date.now() + 3_600_000));

    expect(res.status).toBe(201);
    expect(stored()).toBe(1);
  });

  it("accepts a null expirationTime, which is what browsers send when there is none", async () => {
    expect((await subscribe(body(null))).status).toBe(201);
    expect(stored()).toBe(1);
  });

  it("accepts a payload with no expirationTime, so existing clients keep working", async () => {
    expect((await subscribe(body())).status).toBe(201);
    expect(stored()).toBe(1);
  });

  it("rejects a non-numeric or non-finite expirationTime as a malformed payload", async () => {
    for (const bad of ["tomorrow", true, {}, [1]]) {
      const payload = body();
      (payload.subscription as Record<string, unknown>).expirationTime = bad;
      expect((await subscribe(payload)).status).toBe(400);
    }
    expect(stored()).toBe(0);
  });

  it("an expired re-subscribe does not overwrite the live subscription for that endpoint", async () => {
    const live = body(Date.now() + 3_600_000);
    expect((await subscribe(live)).status).toBe(201);
    const expired = {
      ...live,
      subscription: { ...live.subscription, expirationTime: Date.now() - 1, keys: { p256dh: "other", auth: "other" } },
    };

    expect((await subscribe(expired)).status).toBe(400);

    const rows = listPushSubscriptionsByOwner(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe("p256dh-key");
  });
});
