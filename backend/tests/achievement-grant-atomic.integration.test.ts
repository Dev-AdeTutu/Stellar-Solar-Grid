/**
 * #1165: a failed write during an achievement grant must not leave a half-applied grant.
 *
 * The issue describes gamification points that are deducted on rollback after never being added.
 * There are no points in this module: a grant is an unlock row plus an activity entry. The same
 * hazard exists there, though: the two writes were separate, so a failure on the second left the
 * achievement recorded as unlocked with nothing announcing it. They now run in one transaction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as StellarSdk from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// On upstream main `src/lib/stellar.ts` imports a `quantumCrypto.js` that does not exist, and
// `src/lib/auditTrail.ts` has a leftover merge-conflict marker. Neither is the subject here.
vi.mock("../src/lib/stellar.js", () => ({}));
vi.mock("../src/lib/auditTrail.js", () => ({ recordAudit: vi.fn() }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-achievement-atomic-"));
const SOCIAL_DB = path.join(tmpDir, "social.sqlite");
process.env.SOCIAL_DB_PATH = SOCIAL_DB;
process.env.USAGE_EVENTS_DB_PATH = path.join(tmpDir, "usage-events.sqlite");

let social: typeof import("../src/lib/social");
let usageEvents: typeof import("../src/lib/usageEvents");
let side: Database.Database; // a second connection, to break and inspect the module's database

const ACTIVITY_DDL = `CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, type TEXT NOT NULL,
  message TEXT NOT NULL, created_at TEXT NOT NULL)`;

const newAddress = () => StellarSdk.Keypair.random().publicKey();
const unlockRows = (address: string) =>
  side.prepare("SELECT achievement_id FROM user_achievements WHERE address = ?").all(address) as { achievement_id: string }[];
const activityRows = (address: string) =>
  side.prepare("SELECT message FROM activity WHERE address = ? AND type = 'achievement'").all(address) as { message: string }[];

function recordUsage(meterId: string, events = 1) {
  for (let i = 0; i < events; i++) {
    usageEvents.db()
      .prepare("INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, '1', ?, 'submitted')")
      .run(meterId, 1, new Date().toISOString());
  }
}

beforeAll(async () => {
  social = await import("../src/lib/social");
  usageEvents = await import("../src/lib/usageEvents");
  side = new Database(SOCIAL_DB);
});

afterAll(() => {
  side?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ids = (address: string) => unlockRows(address).map((r) => r.achievement_id).sort();

/** Every unlock has exactly one activity entry announcing it, and nothing else does. */
const expectUnlocksAndActivityAgree = (address: string) =>
  expect(activityRows(address)).toHaveLength(unlockRows(address).length);

describe("granting an achievement", () => {
  it("records the unlock and exactly one activity entry for it", () => {
    const address = newAddress();
    social.upsertProfile(address, { displayName: "Grace", meterIds: ["M-GRACE"] });
    const before = ids(address);
    recordUsage("M-GRACE");

    const unlocked = social.syncAchievements(address);

    expect(unlocked).toContain("first_spark");
    expect(ids(address)).toEqual([...before, ...unlocked].sort());
    expectUnlocksAndActivityAgree(address);
  });

  it("is idempotent: syncing again grants nothing and logs nothing more", () => {
    const address = newAddress();
    social.upsertProfile(address, { displayName: "Ida", meterIds: ["M-IDA"] });
    recordUsage("M-IDA");
    const first = social.syncAchievements(address);
    const rowsAfterFirst = ids(address);

    expect(social.syncAchievements(address)).toEqual([]);
    expect(social.syncAchievements(address)).toEqual([]);

    expect(first.length).toBeGreaterThan(0);
    expect(ids(address)).toEqual(rowsAfterFirst);
    expectUnlocksAndActivityAgree(address);
  });

  it("leaves no unlock row behind when the activity write fails, and grants cleanly on the next sync", () => {
    const address = newAddress();
    social.upsertProfile(address, { displayName: "Ken", meterIds: ["M-KEN"] });
    const before = ids(address);
    side.exec("DROP TABLE activity");
    try {
      recordUsage("M-KEN");

      expect(() => social.syncAchievements(address)).toThrow();
      expect(ids(address), "a failed grant must not leave the achievement unlocked").toEqual(before);
    } finally {
      side.exec(ACTIVITY_DDL);
    }

    const unlocked = social.syncAchievements(address);

    expect(unlocked).toContain("first_spark");
    expect(ids(address)).toEqual([...before, ...unlocked].sort());
  });

  it("a failure for one user does not touch another user's grants", () => {
    const ok = newAddress();
    const broken = newAddress();
    social.upsertProfile(ok, { displayName: "Ola", meterIds: ["M-OLA"] });
    social.upsertProfile(broken, { displayName: "Pat", meterIds: ["M-PAT"] });
    recordUsage("M-OLA");
    social.syncAchievements(ok);
    const okBefore = ids(ok);
    const brokenBefore = ids(broken);
    recordUsage("M-PAT");
    side.exec("DROP TABLE activity");
    try {
      expect(() => social.syncAchievements(broken)).toThrow();
    } finally {
      side.exec(ACTIVITY_DDL);
    }

    expect(ids(ok)).toEqual(okBefore);
    expect(ids(broken)).toEqual(brokenBefore);
  });
});

describe("what an achievement is", () => {
  it("carries no points or balance, so there is nothing to deduct", () => {
    const address = newAddress();
    social.upsertProfile(address, { displayName: "Sam", meterIds: ["M-SAM"] });
    recordUsage("M-SAM");
    social.syncAchievements(address);

    for (const a of social.getUserAchievements(address)) {
      expect(Object.keys(a).sort()).toEqual(["description", "id", "name", "unlockedAt"]);
    }
    const profile = social.getProfile(address)!;
    expect(JSON.stringify(profile).toLowerCase()).not.toMatch(/points|balance/);
  });

  it("only ever adds unlocks: a later sync with less qualifying data does not remove one", () => {
    const address = newAddress();
    social.upsertProfile(address, { displayName: "Tia", meterIds: ["M-TIA"] });
    recordUsage("M-TIA");
    const unlocked = social.syncAchievements(address);

    social.upsertProfile(address, { meterIds: [] });
    social.syncAchievements(address);

    expect(unlocked.length).toBeGreaterThan(0);
    expect(unlockRows(address).map((r) => r.achievement_id)).toEqual(expect.arrayContaining(unlocked));
  });
});
