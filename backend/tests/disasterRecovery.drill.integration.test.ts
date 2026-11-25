import express from "express";
import { createServer, type Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisasterRecovery, type DrAdapter } from "../src/lib/disasterRecovery.js";

const TEST_SECRET = "disaster-recovery-test-secret";
const originalAdminApiKey = process.env.ADMIN_API_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

const adapter: DrAdapter = {
  lastReplicatedAt: async () => Date.now(),
  replicate: async () => undefined,
  activate: async () => undefined,
  healthCheck: async () => true,
};

async function createTestServer(role?: string): Promise<{ server: Server; baseUrl: string; token?: string }> {
  process.env.ADMIN_API_KEY = TEST_SECRET;
  process.env.JWT_SECRET = TEST_SECRET;
  vi.resetModules();
  const { createDisasterRecoveryRouter } = await import("../src/routes/disasterRecovery.js");

  const app = express();
  app.use("/api/disaster-recovery", createDisasterRecoveryRouter(new DisasterRecovery(adapter)));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const token = role ? jwt.sign({ role }, TEST_SECRET, { expiresIn: "5m" }) : undefined;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, token };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("disaster recovery drill authorization (#1187)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    if (originalAdminApiKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminApiKey;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it.each(["admin", "ops"])("allows a verified %s role to run a drill", async (role) => {
    const testServer = await createTestServer(role);
    server = testServer.server;
    const response = await fetch(`${testServer.baseUrl}/api/disaster-recovery/drill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testServer.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ drill: true, activeSite: "primary" });
  });

  it("rejects a verified role without drill privileges", async () => {
    const testServer = await createTestServer("viewer");
    server = testServer.server;
    const response = await fetch(`${testServer.baseUrl}/api/disaster-recovery/drill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testServer.token}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const testServer = await createTestServer();
    server = testServer.server;
    const response = await fetch(`${testServer.baseUrl}/api/disaster-recovery/drill`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});
