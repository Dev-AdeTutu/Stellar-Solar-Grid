/**
 * Meter lifespan & depreciation tracking (#998).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-depreciation-"));
process.env.METER_DEPRECIATION_DB_PATH = path.join(tmpDir, "meter-depreciation.sqlite");

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-01T00:00:00.000Z");
const yearsAgo = (years: number) => new Date(NOW.getTime() - years * MS_PER_YEAR).toISOString();

let lib: typeof import("../src/lib/meterDepreciation");
let routes: typeof import("../src/routes/meterDepreciation");
let server: Server;
let base: string;

beforeAll(async () => {
  lib = await import("../src/lib/meterDepreciation");
  routes = await import("../src/routes/meterDepreciation");

  lib.registerMeterAsset({ meterId: "M-OLD", installedAt: yearsAgo(10), expectedLifespanYears: 15, purchaseCostStroops: 900_000_000 });
  lib.registerMeterAsset({ meterId: "M-NEARLY-DEAD", installedAt: yearsAgo(14.5), expectedLifespanYears: 15 });
  lib.registerMeterAsset({ meterId: "M-NEW", installedAt: yearsAgo(0.5), expectedLifespanYears: 15 });

  const app = express();
  app.use(express.json());
  app.use("/api/meters", routes.meterDepreciationRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getAssetInfo", () => {
  it("computes age, remaining lifespan and depreciation", () => {
    const info = lib.getAssetInfo("M-OLD", NOW)!;
    expect(info.ageYears).toBe(10);
    expect(info.remainingYears).toBe(5);
    expect(info.depreciationPercent).toBeCloseTo(66.67, 1);
    expect(info.nearEndOfLife).toBe(false);
  });

  it("depreciates book value in proportion to age", () => {
    const info = lib.getAssetInfo("M-OLD", NOW)!;
    // 900,000,000 stroops at ~66.67% depreciated ≈ 300,000,000 remaining.
    expect(info.bookValueStroops).toBeCloseTo(300_000_000, -5);
  });

  it("flags meters within the end-of-life warning window", () => {
    const info = lib.getAssetInfo("M-NEARLY-DEAD", NOW)!;
    expect(info.remainingYears).toBeCloseTo(0.5, 1);
    expect(info.nearEndOfLife).toBe(true);
  });

  it("defaults the expected lifespan to 15 years when not specified", () => {
    lib.registerMeterAsset({ meterId: "M-DEFAULT", installedAt: yearsAgo(1) });
    expect(lib.getAssetInfo("M-DEFAULT", NOW)!.expectedLifespanYears).toBe(15);
  });

  it("returns undefined for an unregistered meter", () => {
    expect(lib.getAssetInfo("M-UNKNOWN")).toBeUndefined();
  });
});

describe("getAssetReport", () => {
  it("summarizes the fleet and lists meters nearing end of life, soonest first", () => {
    const report = lib.getAssetReport(NOW);
    expect(report.meters).toBeGreaterThanOrEqual(3);
    expect(report.nearEndOfLife.map((m) => m.meterId)).toContain("M-NEARLY-DEAD");
    expect(report.nearEndOfLife[0].meterId).toBe("M-NEARLY-DEAD");
  });
});

describe("checkEndOfLifeMeters", () => {
  it("returns the IDs of meters approaching end of life", () => {
    expect(lib.checkEndOfLifeMeters(NOW)).toContain("M-NEARLY-DEAD");
  });
});

describe("HTTP endpoints", () => {
  it("registers and reads back asset info", async () => {
    const post = await fetch(`${base}/api/meters/M-HTTP/asset-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installedAt: yearsAgo(2).toString(), expectedLifespanYears: 10 }),
    });
    expect(post.status).toBe(201);

    const get = await fetch(`${base}/api/meters/M-HTTP/asset-info`);
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.expectedLifespanYears).toBe(10);
  });

  it("404s for an unregistered meter", async () => {
    const res = await fetch(`${base}/api/meters/does-not-exist/asset-info`);
    expect(res.status).toBe(404);
  });

  it("rejects an invalid payload", async () => {
    const res = await fetch(`${base}/api/meters/M-HTTP/asset-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedLifespanYears: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it("serves the fleet-wide report", async () => {
    const res = await fetch(`${base}/api/meters/asset-info/report`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meters).toBeGreaterThan(0);
  });
});
