/**
 * Energy consumption gamification (#996): achievements, region leaderboards
 * and the top-level /api/achievements and /api/leaderboards endpoints.
 *
 * social.ts and usageEvents.ts read their DB path from env vars once, at
 * module load — so these are set to isolated temp files and the modules are
 * imported dynamically, after the env vars are in place.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-gamification-"));
process.env.SOCIAL_DB_PATH = path.join(tmpDir, "social.sqlite");
process.env.USAGE_EVENTS_DB_PATH = path.join(tmpDir, "usage-events.sqlite");

const ADDRESS_A = StellarSdk.Keypair.random().publicKey();
const ADDRESS_B = StellarSdk.Keypair.random().publicKey();

let social: typeof import("../src/lib/social");
let usageEvents: typeof import("../src/lib/usageEvents");
let gamification: typeof import("../src/routes/gamification");

let server: Server;
let base: string;

function insertUsage(meterId: string, receivedAt: string, units: number) {
  usageEvents
    .db()
    .prepare("INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, ?, ?, 'submitted')")
    .run(meterId, units, String(units * 0.1), receivedAt);
}

beforeAll(async () => {
  social = await import("../src/lib/social");
  usageEvents = await import("../src/lib/usageEvents");
  gamification = await import("../src/routes/gamification");

  // Off-peak, growing-then-shrinking usage for address A so it both avoids
  // peak hours and shows a week-over-week reduction.
  for (let d = 13; d >= 7; d--) {
    insertUsage("M-A", new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 11) + "02:00:00.000Z", 20);
  }
  for (let d = 6; d >= 0; d--) {
    insertUsage("M-A", new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 11) + "02:00:00.000Z", 5);
  }
  social.upsertProfile(ADDRESS_A, {
    displayName: "Saver A",
    bio: "I save energy",
    avatarUrl: "https://example.com/a.png",
    meterIds: ["M-A"],
    region: "ng",
  });

  // Address B consumes far more green energy, so it should rank #1 on the green board.
  insertUsage("M-B", new Date().toISOString(), 50_000);
  social.upsertProfile(ADDRESS_B, {
    displayName: "Big Solar",
    meterIds: ["M-B"],
    region: "KE",
  });

  const app = express();
  app.use(express.json());
  app.use("/api/achievements", gamification.achievementsRouter);
  app.use("/api/leaderboards", gamification.leaderboardsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("achievements", () => {
  it("unlocks the peak-avoider and 7-day-saver achievements from usage trends", () => {
    const unlocked = social.syncAchievements(ADDRESS_A);
    expect(unlocked).toContain("peak_avoider");
    expect(unlocked).toContain("seven_day_saver");
  });

  it("does not unlock solar_champion from stats alone", () => {
    const unlocked = social.syncAchievements(ADDRESS_A);
    expect(unlocked).not.toContain("solar_champion");
  });

  it("awards solar_champion to the #1 green-leaderboard profile on refresh", () => {
    const boards = social.refreshLeaderboards();
    expect(boards.green[0]?.address).toBe(ADDRESS_B);
    const achievements = social.getUserAchievements(ADDRESS_B);
    expect(achievements.find((a) => a.id === "solar_champion")?.unlockedAt).not.toBeNull();
  });
});

describe("region leaderboard", () => {
  it("groups top savers by region", () => {
    social.refreshLeaderboards();
    const regions = social.getRegionLeaderboard();
    expect(regions.NG?.[0]?.address).toBe(ADDRESS_A);
    expect(regions.KE?.[0]?.address).toBe(ADDRESS_B);
  });
});

describe("GET /api/achievements", () => {
  it("returns the full catalogue without an address", async () => {
    const res = await fetch(`${base}/api/achievements`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.achievements.some((a: { id: string }) => a.id === "peak_avoider")).toBe(true);
  });

  it("returns unlock status for a known address", async () => {
    const res = await fetch(`${base}/api/achievements?address=${ADDRESS_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const peakAvoider = body.achievements.find((a: { id: string }) => a.id === "peak_avoider");
    expect(peakAvoider.unlockedAt).not.toBeNull();
  });

  it("rejects an invalid address", async () => {
    const res = await fetch(`${base}/api/achievements?address=not-an-address`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/leaderboards", () => {
  it("returns the global green board by default", async () => {
    const res = await fetch(`${base}/api/leaderboards`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.board).toBe("green");
    expect(body.entries[0].address).toBe(ADDRESS_B);
  });

  it("filters by region", async () => {
    const res = await fetch(`${base}/api/leaderboards?region=ng`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.region).toBe("NG");
    expect(body.entries[0].address).toBe(ADDRESS_A);
  });

  it("rejects region filtering on the trader board", async () => {
    const res = await fetch(`${base}/api/leaderboards?board=trader&region=ng`);
    expect(res.status).toBe(400);
  });
});
