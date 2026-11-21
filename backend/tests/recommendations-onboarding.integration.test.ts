/**
 * #1164: a new meter with too little history gets onboarding tips and an explanation, not a bare
 * empty array.
 */
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The recommendations code reads usage through `initUsageEventStore`. The real module is not loaded
// here: on upstream main its import chain fails (`src/lib/auditTrail.ts` has a leftover merge
// conflict marker, and `src/lib/stellar.ts` imports a missing `quantumCrypto.js`). An in-memory
// database with the one table the code reads stands in for it.
const store = vi.hoisted(() => ({ db: undefined as unknown as import("better-sqlite3").Database }));

vi.mock("../src/lib/usageEvents.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  store.db = new Database(":memory:");
  store.db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      units INTEGER NOT NULL,
      cost TEXT NOT NULL,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  return { initUsageEventStore: () => store.db };
});
vi.mock("../src/lib/stellar.js", () => ({}));
// Pattern analysis opens its own database file at import; the rule-based candidates are enough here.
vi.mock("../src/lib/consumptionAnalytics.js", () => ({ analyzeConsumption: () => ({ totalKwh: 0, peakHours: [] }) }));
vi.mock("../src/lib/auditTrail.js", () => ({ recordAudit: vi.fn() }));
// `recommendations.ts` imports `selectNudge`, which `nudges.ts` does not export, so nudge attachment
// fails (and is caught and logged) on upstream main. Not the subject here; keep the output quiet.
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const {
  MIN_HISTORY_DAYS,
  ONBOARDING_RECOMMENDATIONS,
  generateWeekly,
  recommendationsOrOnboarding,
  respond,
  usageHistoryDays,
} = await import("../src/lib/recommendations.js");
const { recommendationsRouter } = await import("../src/routes/recommendations.js");

const db = store.db;
let meterSeq = 0;
const newMeter = () => `ONBOARD-${(meterSeq += 1)}`;

/** One usage event per listed day offset (0 = today), at the given hour. */
function seedUsage(meterId: string, daysAgo: number[], hour = 19, units = 4_000) {
  const insert = db.prepare(
    "INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, '1', datetime('now', ?, ?), 'submitted')",
  );
  for (const d of daysAgo) insert.run(meterId, units, `-${d} days`, `start of day`);
  // Move each event to the requested hour of its day.
  db.prepare("UPDATE usage_events SET received_at = datetime(received_at, ?) WHERE meter_id = ?").run(`+${hour} hours`, meterId);
}

const days = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("usageHistoryDays", () => {
  it("is 0 for a meter that has never reported", () => {
    expect(usageHistoryDays(newMeter())).toBe(0);
  });

  it("counts distinct days, not events", () => {
    const meter = newMeter();
    seedUsage(meter, [0, 0, 0, 1, 1]);
    expect(usageHistoryDays(meter)).toBe(2);
  });

  it("ignores failed events and other meters", () => {
    const meter = newMeter();
    const other = newMeter();
    seedUsage(meter, [0]);
    seedUsage(other, [0, 1, 2]);
    db.prepare("UPDATE usage_events SET status = 'failed' WHERE meter_id = ?").run(other);
    expect(usageHistoryDays(meter)).toBe(1);
    expect(usageHistoryDays(other)).toBe(0);
  });
});

describe("recommendationsOrOnboarding", () => {
  it("gives a brand new meter the onboarding tips and says why", () => {
    const result = recommendationsOrOnboarding(newMeter());

    expect(result.onboarding).toBe(true);
    expect(result.recommendations).toEqual(ONBOARDING_RECOMMENDATIONS);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.historyDays).toBe(0);
    expect(result.minHistoryDays).toBe(MIN_HISTORY_DAYS);
    expect(result.reason).toContain("7 days");
    expect(result.reason).toContain("has 0");
  });

  it.each([1, 3, 6])("still gives onboarding tips with %s day(s) of history, and reports the count", (n) => {
    const meter = newMeter();
    seedUsage(meter, days(n));

    const result = recommendationsOrOnboarding(meter);

    expect(result).toMatchObject({ onboarding: true, historyDays: n });
    expect(result.reason).toContain(`has ${n}`);
  });

  it("does not give onboarding tips once there are 7 days of history", () => {
    const meter = newMeter();
    seedUsage(meter, days(7));

    expect(recommendationsOrOnboarding(meter)).toEqual({ recommendations: [], onboarding: false });
  });

  it("returns the real recommendations, not the tips, when they exist", () => {
    const meter = newMeter();
    seedUsage(meter, days(10), 19, 6_000);
    const generated = generateWeekly(meter);
    expect(generated.length).toBeGreaterThan(0);

    const result = recommendationsOrOnboarding(meter);

    expect(result.onboarding).toBe(false);
    expect(result.recommendations).toEqual(generated);
    expect(result.reason).toBeUndefined();
  });

  it("prefers real recommendations even when history is short", () => {
    const meter = newMeter();
    seedUsage(meter, days(3), 19, 6_000);
    const generated = generateWeekly(meter);
    if (generated.length === 0) return; // no personalised candidate for this tiny history: nothing to prefer

    expect(recommendationsOrOnboarding(meter).onboarding).toBe(false);
  });

  it("stays an empty list, without onboarding, when an established meter dismissed everything", () => {
    const meter = newMeter();
    seedUsage(meter, days(10), 19, 6_000);
    for (const rec of generateWeekly(meter)) respond(meter, rec.id, "dismiss");
    db.prepare("DELETE FROM recommendations WHERE meter_id = ?").run(meter);

    expect(recommendationsOrOnboarding(meter)).toEqual({ recommendations: [], onboarding: false });
  });
});

describe("onboarding tips", () => {
  it("are marked as onboarding, have string ids that cannot collide with database ids, and carry a priority", () => {
    for (const tip of ONBOARDING_RECOMMENDATIONS) {
      expect(tip.onboarding).toBe(true);
      expect(typeof tip.id).toBe("string");
      expect(Number.isNaN(Number(tip.id))).toBe(true);
      expect(["high", "medium", "low"]).toContain(tip.priority);
      expect(tip.message.length).toBeGreaterThan(20);
    }
    expect(new Set(ONBOARDING_RECOMMENDATIONS.map((t) => t.id)).size).toBe(ONBOARDING_RECOMMENDATIONS.length);
  });

  it("make no savings claim, since there is no data to base one on", () => {
    for (const tip of ONBOARDING_RECOMMENDATIONS) {
      expect(tip).not.toHaveProperty("estimatedWeeklySavingKwh");
      expect(tip.message).not.toMatch(/\d+\s*(kwh|%|\$)/i);
    }
  });

  it("cannot be accepted or dismissed as if they were stored recommendations", () => {
    expect(respond(newMeter(), Number(ONBOARDING_RECOMMENDATIONS[0].id), "accept")).toBeNull();
  });

  it("are returned as a copy, so a caller cannot change the defaults", () => {
    const result = recommendationsOrOnboarding(newMeter());
    result.recommendations.pop();
    expect(recommendationsOrOnboarding(newMeter()).recommendations).toHaveLength(ONBOARDING_RECOMMENDATIONS.length);
  });
});

describe("GET /api/recommendations/:meterId", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/recommendations", recommendationsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns onboarding tips, the flag and the reason for a new meter, keeping the recommendations key", async () => {
    const res = await fetch(`${baseUrl}/api/recommendations/${newMeter()}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.recommendations).toHaveLength(ONBOARDING_RECOMMENDATIONS.length);
    expect(body).toMatchObject({ onboarding: true, historyDays: 0, minHistoryDays: 7 });
    expect(body.reason).toMatch(/at least 7 days/);
  });

  it("returns a plain list without the onboarding fields for an established meter", async () => {
    const meter = newMeter();
    seedUsage(meter, days(10), 19, 6_000);
    generateWeekly(meter);

    const body = await (await fetch(`${baseUrl}/api/recommendations/${meter}`)).json();

    expect(body.onboarding).toBe(false);
    expect(body.reason).toBeUndefined();
    expect(body.recommendations.every((r: { onboarding?: boolean }) => r.onboarding === undefined)).toBe(true);
  });
});
