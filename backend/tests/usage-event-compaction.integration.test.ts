/**
 * Integration test: usage_events retention/compaction job (Closes #685)
 *
 * Exercises compactUsageEvents() against a real (file-backed) SQLite
 * database: detailed rows older than the detail-retention window are rolled
 * into usage_summary and deleted; rows older than the archive-retention
 * window are additionally written to a gzipped JSONL archive file first.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { describe, it, expect, afterAll, vi } from "vitest";

// Static imports are hoisted above plain statements, so without vi.hoisted()
// usageEvents.ts's module-top-level
// `const DB_PATH = process.env.USAGE_EVENTS_DB_PATH ?? ...` would run before
// these assignments and silently fall back to the default (real) DB path.
// Everything the env vars depend on (tmpDir, dbPath, archiveDir) is computed
// inside the hoisted callback too, since it runs before the `const`
// declarations further down the file would otherwise have initialized.
// Built from process.pid/Date.now()/Math.random() rather than
// fs.mkdtempSync + path.join: vi.hoisted() callbacks run before this file's
// own `import fs from "node:fs"` etc. are linked, so only ambient globals
// like `process` and `Math` are safe to use here.
const { tmpDir, dbPath, archiveDir } = vi.hoisted(() => {
  const tmpDir = `${(process as any).env.TMPDIR ?? "/tmp"}/usage-compaction-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = `${tmpDir}/usage-events.sqlite`;
  const archiveDir = `${tmpDir}/archive`;
  process.env.USAGE_EVENTS_DB_PATH = dbPath;
  process.env.USAGE_ARCHIVE_DIR = archiveDir;
  process.env.USAGE_DETAIL_RETENTION_DAYS = "90";
  process.env.USAGE_ARCHIVE_RETENTION_DAYS = "365";
  return { tmpDir, dbPath, archiveDir };
});

// usageEvents.ts imports adminInvoke from stellar.ts, which constructs a
// StellarService (and a Keypair) at module load time. Nothing in this
// suite submits on-chain, so stub the module out entirely.
vi.mock("../src/lib/stellar.js", () => ({
  adminInvoke: vi.fn(),
  contractQuery: vi.fn(),
  stellarService: { query: vi.fn(), invoke: vi.fn() },
}));

import { recordUsageEvent, compactUsageEvents, getUsageSummary } from "../src/lib/usageEvents.js";

/** Direct connection to the same file so the test can backdate rows. */
const rawDb = new Database(dbPath);

function backdate(id: number, daysAgo: number, status: "submitted" | "pending" | "failed" = "submitted") {
  const receivedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  rawDb
    .prepare("UPDATE usage_events SET received_at = ?, status = ? WHERE id = ?")
    .run(receivedAt, status, id);
}

afterAll(() => {
  rawDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("compactUsageEvents", () => {
  it("leaves recent events untouched", () => {
    const recent = recordUsageEvent({ meterId: "METER_RECENT", units: 10, cost: 5000 });
    backdate(recent.id, 5); // 5 days old — well inside the 90-day detail window

    const result = compactUsageEvents();

    const stillThere = rawDb.prepare("SELECT * FROM usage_events WHERE id = ?").get(recent.id);
    expect(stillThere).toBeDefined();
    expect(result.compactedCount).toBe(0);
  });

  it("rolls events older than the detail window into usage_summary and deletes them", () => {
    const e1 = recordUsageEvent({ meterId: "METER_OLD", units: 100, cost: 500_000 });
    const e2 = recordUsageEvent({ meterId: "METER_OLD", units: 50, cost: 250_000 });
    backdate(e1.id, 120); // 120 days old — past the 90-day detail window
    backdate(e2.id, 120);

    const result = compactUsageEvents();

    expect(result.compactedCount).toBeGreaterThanOrEqual(2);
    expect(result.vacuumed).toBe(true);

    const remaining = rawDb
      .prepare("SELECT * FROM usage_events WHERE id IN (?, ?)")
      .all(e1.id, e2.id);
    expect(remaining.length).toBe(0);

    const summary = getUsageSummary("METER_OLD");
    expect(summary.length).toBeGreaterThanOrEqual(1);
    const row = summary[0];
    expect(row.total_units).toBeGreaterThanOrEqual(150);
    expect(row.total_cost).toBeGreaterThanOrEqual(750_000);
    expect(row.event_count).toBeGreaterThanOrEqual(2);
  });

  it("does not touch pending or failed events regardless of age", () => {
    const pending = recordUsageEvent({ meterId: "METER_PENDING", units: 1, cost: 1 });
    backdate(pending.id, 400, "pending");
    const failed = recordUsageEvent({ meterId: "METER_FAILED", units: 1, cost: 1 });
    backdate(failed.id, 400, "failed");

    compactUsageEvents();

    const rows = rawDb
      .prepare("SELECT id, status FROM usage_events WHERE id IN (?, ?)")
      .all(pending.id, failed.id) as Array<{ id: number; status: string }>;
    expect(rows.length).toBe(2);
  });

  it("archives events older than the archive-retention window before deleting them", () => {
    const ancient = recordUsageEvent({ meterId: "METER_ANCIENT", units: 7, cost: 42 });
    backdate(ancient.id, 400); // past the 365-day archive window

    const result = compactUsageEvents();

    expect(result.archivedCount).toBeGreaterThanOrEqual(1);
    expect(result.archiveFile).toBeTruthy();
    expect(fs.existsSync(result.archiveFile!)).toBe(true);

    const contents = zlib.gunzipSync(fs.readFileSync(result.archiveFile!)).toString("utf8");
    const lines = contents.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((r) => r.id === ancient.id && r.meter_id === "METER_ANCIENT")).toBe(true);

    const stillThere = rawDb.prepare("SELECT * FROM usage_events WHERE id = ?").get(ancient.id);
    expect(stillThere).toBeUndefined();
  });

  it("is idempotent — a second run with nothing new to compact is a no-op", () => {
    const result = compactUsageEvents();
    expect(result.compactedCount).toBe(0);
    expect(result.vacuumed).toBe(false);
  });

  it("respects custom retention overrides", () => {
    const e = recordUsageEvent({ meterId: "METER_CUSTOM", units: 3, cost: 9 });
    backdate(e.id, 10);

    const result = compactUsageEvents({ detailedRetentionDays: 5, archiveRetentionDays: 5 });

    expect(result.compactedCount).toBeGreaterThanOrEqual(1);
    const stillThere = rawDb.prepare("SELECT * FROM usage_events WHERE id = ?").get(e.id);
    expect(stillThere).toBeUndefined();
  });
});
