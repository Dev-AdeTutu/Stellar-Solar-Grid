import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";

process.env.USAGE_EVENTS_DB_PATH = ":memory:";

const { pushSubscriptionsRouter } = await import("../src/routes/pushSubscriptions.js");
const { closeUsageEventStore } = await import("../src/lib/usageEvents.js");
let server: Server;
let baseUrl = "";
const ownerAddress = `G${"A".repeat(55)}`;
const token = "ExponentPushToken[mobile-native-push-token-123456]";

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
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeUsageEventStore();
});

describe("native push subscriptions", () => {
  it("rejects malformed Expo tokens", async () => {
    const response = await fetch(`${baseUrl}/api/push/native/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerAddress, token: "not-an-expo-token", platform: "ios" }),
    });
    expect(response.status).toBe(400);
  });

  it("registers and removes an Expo device token", async () => {
    const subscribe = await fetch(`${baseUrl}/api/push/native/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerAddress, token, platform: "ios" }),
    });
    expect(subscribe.status).toBe(201);

    const unsubscribe = await fetch(`${baseUrl}/api/push/native/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(unsubscribe.status).toBe(200);
  });
});