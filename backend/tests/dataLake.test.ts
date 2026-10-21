// Simple test runner: exit 0 on pass, 1 on fail
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DataLake } from "../src/lake/dataLake.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lake-"));
const db = new Database(":memory:");
db.exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, meter_id TEXT, units INTEGER,
  cost TEXT, received_at TEXT, status TEXT, on_chain_tx_hash TEXT)`);
const ins = db.prepare(
  "INSERT INTO usage_events (meter_id, units, cost, received_at, status) VALUES (?, ?, ?, ?, 'submitted')",
);
ins.run("M1", 10, "100", "2026-01-01T10:00:00.000Z");
ins.run("M1", 5, "50", "2026-01-02T10:00:00.000Z");
ins.run("M2", 7, "70", "2026-01-02T11:00:00.000Z");

const lake = new DataLake(root, 30);
try {
  const r = lake.runEtl(db);
  assert.equal(r.exported, 3);
  assert.deepEqual(lake.listPartitions(), ["2026-01-01", "2026-01-02"]);
  assert.equal(lake.runEtl(db).exported, 0, "ETL is incremental");

  ins.run("M2", 3, "30", "2026-01-03T00:00:00.000Z");
  assert.equal(lake.runEtl(db).exported, 1);

  assert.equal(lake.query({ from: "2026-01-02", to: "2026-01-02" }).length, 2, "partition pruning");
  const m1 = lake.summarize({ meterId: "M1" });
  assert.deepEqual(m1, [{ meterId: "M1", events: 2, totalUnits: 15, totalCost: "150" }]);

  const removed = lake.applyRetention(new Date("2026-02-01T12:00:00Z"));
  assert.deepEqual(removed, ["2026-01-01"]);
  assert.deepEqual(lake.listPartitions(), ["2026-01-02", "2026-01-03"]);
  console.log("dataLake tests passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
