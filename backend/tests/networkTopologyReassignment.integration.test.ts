import express from "express";
import { createServer, type Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "network-topology-test-secret";
const originalAdminApiKey = process.env.ADMIN_API_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

let server: Server;
let baseUrl: string;
let opsToken: string;

beforeEach(async () => {
  process.env.ADMIN_API_KEY = TEST_SECRET;
  process.env.JWT_SECRET = TEST_SECRET;
  vi.resetModules();
  const { resetTopologyStore } = await import("../src/lib/networkTopology.js");
  const { networkTopologyRouter } = await import("../src/routes/networkTopology.js");
  resetTopologyStore();
  opsToken = jwt.sign({ role: "ops" }, TEST_SECRET, { expiresIn: "5m" });

  const app = express();
  app.use(express.json());
  app.use("/api/network", networkTopologyRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalAdminApiKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalAdminApiKey;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

describe("network topology feeder reassignment (#1184)", () => {
  it("returns freshly generated links and weights for the assigned transformer", async () => {
    const response = await fetch(`${baseUrl}/api/network/topology/nodes/meter-101/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify({ parentId: "tx-south-1" }),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as {
      node: { parentId: string };
      graph: { links: Array<{ source: string; target: string; loadPercentage: number }> };
    };
    expect(result.node.parentId).toBe("tx-south-1");
    expect(result.graph.links).not.toContainEqual(expect.objectContaining({
      source: "tx-north-1",
      target: "meter-101",
    }));
    expect(result.graph.links).toContainEqual(expect.objectContaining({
      source: "tx-south-1",
      target: "meter-101",
      loadPercentage: 28,
    }));
  });

  it("rejects a destination that is not a transformer", async () => {
    const response = await fetch(`${baseUrl}/api/network/topology/nodes/meter-101/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsToken}` },
      body: JSON.stringify({ parentId: "grid-main-1" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects reassignment without verified credentials", async () => {
    const response = await fetch(`${baseUrl}/api/network/topology/nodes/meter-101/parent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: "tx-south-1" }),
    });
    expect(response.status).toBe(401);
  });
});
