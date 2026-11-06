/**
 * Meter config backup (#1055), locational marginal pricing (#1057) and
 * anonymous meter authentication (#1058).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import express from "express";

const ADMIN_KEY = "test-admin-key";
vi.hoisted(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
});
vi.mock("../src/lib/pushNotifications", () => ({ sendPushToOwner: vi.fn().mockResolvedValue(undefined) }));

import { meterConfigRouter } from "../src/routes/meterConfig";
import { locationalPricingRouter } from "../src/routes/locationalPricing";
import { anonymousAuthRouter } from "../src/routes/anonymousAuth";
import { resetConfigBackups } from "../src/lib/meterConfigBackup";
import { computeRegionPrice, repriceAll, resetLocationalPricing, upsertRegion, heatmap } from "../src/lib/locationalPricing";
import { recordLoad, resetCongestionState, setZoneCapacity } from "../src/lib/congestionPricing";
import { blind, resetAnonymousAuth, unblind } from "../src/lib/anonymousAuth";
import { sendPushToOwner } from "../src/lib/pushNotifications";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/meter-config", meterConfigRouter);
  app.use("/api/pricing", locationalPricingRouter);
  app.use("/api/anon-auth", anonymousAuthRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  resetConfigBackups();
  resetLocationalPricing();
  resetCongestionState();
  resetAnonymousAuth();
});

const call = (method: string, path: string, body?: unknown, admin = false) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(admin ? { "x-admin-key": ADMIN_KEY } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("meter config backup (#1055)", () => {
  it("versions configs, dedupes identical backups, and restores to a replacement meter", async () => {
    const r1 = await (await call("POST", "/api/meter-config/M1/backup", { config: { rate: 5, tz: "UTC" } })).json();
    expect(r1.version).toBe(1);
    const dup = await (await call("POST", "/api/meter-config/M1/backup", { config: { tz: "UTC", rate: 5 } })).json();
    expect(dup.version).toBe(1);
    await call("POST", "/api/meter-config/M1/backup", { config: { rate: 6, tz: "UTC" } });
    expect(await (await call("GET", "/api/meter-config/M1/versions")).json()).toHaveLength(2);

    expect((await call("POST", "/api/meter-config/M2/restore", { sourceMeterId: "M1", version: 1 })).status).toBe(401);
    const restored = await (await call("POST", "/api/meter-config/M2/restore", { sourceMeterId: "M1", version: 1 }, true)).json();
    expect(restored).toMatchObject({ meterId: "M2", version: 1, source: "restore", config: { rate: 5 } });
    const latest = await (await call("GET", "/api/meter-config/M2/versions/latest")).json();
    expect(latest.config).toEqual({ rate: 5, tz: "UTC" });
  });

  it("applies templates with overrides", async () => {
    await call("POST", "/api/meter-config/templates", { name: "rural", config: { rate: 3, tz: "Africa/Lagos" } }, true);
    const v = await (await call("POST", "/api/meter-config/M9/apply-template", { name: "rural", overrides: { rate: 4 } }, true)).json();
    expect(v.config).toEqual({ rate: 4, tz: "Africa/Lagos" });
    expect((await call("GET", "/api/meter-config/M9/versions/7")).status).toBe(404);
  });
});

describe("locational marginal pricing (#1057)", () => {
  it("adds congestion and loss components per region", () => {
    setZoneCapacity("north", 100);
    recordLoad("north", 100); // fully congested → multiplier 3
    const p = computeRegionPrice({ region: "A", zone: "north", lossFactor: 0.05 });
    expect(p.energy).toBe(0.1);
    expect(p.congestion).toBeCloseTo(0.2);
    expect(p.loss).toBeCloseTo(0.005);
    expect(p.price).toBeCloseTo(0.305);
  });

  it("reprices dynamically, notifies subscribers and serves a heatmap", async () => {
    setZoneCapacity("north", 100);
    recordLoad("north", 10);
    await call("PUT", "/api/pricing/regions/A", { zone: "north", lossFactor: 0 }, true);
    await call("PUT", "/api/pricing/regions/B", { zone: "south", lossFactor: 0.1 }, true);
    const owner = `G${"A".repeat(55)}`;
    expect((await call("POST", "/api/pricing/regions/A/subscribe", { ownerAddress: owner })).status).toBe(201);

    recordLoad("north", 100);
    repriceAll();
    expect(sendPushToOwner).toHaveBeenCalledWith(owner, expect.objectContaining({ tag: "lmp-A" }));

    const map = await (await call("GET", "/api/pricing/heatmap")).json();
    expect(map.find((r: { region: string }) => r.region === "A").intensity).toBe(1);
    expect(map.find((r: { region: string }) => r.region === "B").intensity).toBe(0);
    expect(heatmap()).toHaveLength(2);
  });
});

describe("anonymous meter auth (#1058)", () => {
  async function getCredential(deviceId: string) {
    const serial = randomBytes(16).toString("hex");
    const { blinded, r } = blind(serial);
    const res = await call("POST", "/api/anon-auth/issue", { deviceId, blinded: [blinded] });
    if (res.status !== 201) return { res };
    const { signatures } = await res.json();
    return { res, serial, signature: unblind(signatures[0], r) };
  }
  const nonce = async () => (await (await call("GET", "/api/anon-auth/nonce")).json()).nonce;

  it("refuses issuance to unverified meters", async () => {
    expect((await getCredential("dev-x")).res.status).toBe(403);
  });

  it("verifies a credential without the device ID and rejects replay", async () => {
    await call("POST", "/api/anon-auth/meters/dev-1", undefined, true);
    const { serial, signature } = await getCredential("dev-1");
    const ok = await call("POST", "/api/anon-auth/verify", { serial, signature, nonce: await nonce() });
    expect(ok.status).toBe(200);
    expect((await ok.json()).sessionId).toHaveLength(32);

    const replay = await call("POST", "/api/anon-auth/verify", { serial, signature, nonce: await nonce() });
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toMatch(/already used/);
  });

  it("rejects forged signatures and reused nonces", async () => {
    await call("POST", "/api/anon-auth/meters/dev-2", undefined, true);
    const { serial, signature } = await getCredential("dev-2");
    const n = await nonce();
    const forged = await call("POST", "/api/anon-auth/verify", { serial: randomBytes(16).toString("hex"), signature, nonce: n });
    expect(forged.status).toBe(401);
    const reused = await call("POST", "/api/anon-auth/verify", { serial, signature, nonce: n });
    expect((await reused.json()).error).toMatch(/nonce/);
  });
});
