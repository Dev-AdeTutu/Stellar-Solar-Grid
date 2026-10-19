import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Meter telemetry data lake (see backend/DATA_LAKE.md).
 *
 * Layout (Hive-style, S3-compatible):
 *   <root>/meter_telemetry/dt=YYYY-MM-DD/part-<batchId>.ndjson
 *   <root>/_watermark.json   — last usage_events.id exported
 *
 * Point LAKE_ROOT at a mounted bucket (s3fs / goofys / rclone mount) to store
 * the lake on S3 or any equivalent object store.
 */

export type TelemetryRow = {
  id: number;
  meter_id: string;
  units: number;
  cost: string;
  received_at: string;
  status: string;
  on_chain_tx_hash: string | null;
};

export type LakeQuery = { from?: string; to?: string; meterId?: string };

export type LakeSummary = {
  meterId: string;
  events: number;
  totalUnits: number;
  totalCost: string;
};

const TABLE = "meter_telemetry";

export class DataLake {
  constructor(
    readonly root = process.env.LAKE_ROOT ?? path.resolve(process.cwd(), "data", "lake"),
    readonly retentionDays = Number(process.env.LAKE_RETENTION_DAYS ?? 730),
  ) {}

  private tableDir() {
    return path.join(this.root, TABLE);
  }

  private watermarkPath() {
    return path.join(this.root, "_watermark.json");
  }

  getWatermark(): number {
    try {
      return JSON.parse(fs.readFileSync(this.watermarkPath(), "utf8")).lastId ?? 0;
    } catch {
      return 0;
    }
  }

  private setWatermark(lastId: number) {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.watermarkPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastId, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, this.watermarkPath());
  }

  /** ETL: copy new rows from the operational DB into date partitions. */
  runEtl(db: Database.Database, batchSize = 10_000): { exported: number; partitions: string[] } {
    const since = this.getWatermark();
    const rows = db
      .prepare(
        `SELECT id, meter_id, units, cost, received_at, status, on_chain_tx_hash
         FROM usage_events WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(since, batchSize) as TelemetryRow[];
    if (rows.length === 0) return { exported: 0, partitions: [] };

    const byDate = new Map<string, TelemetryRow[]>();
    for (const r of rows) {
      const dt = r.received_at.slice(0, 10);
      if (!byDate.has(dt)) byDate.set(dt, []);
      byDate.get(dt)!.push(r);
    }

    const batchId = `${since + 1}-${rows[rows.length - 1].id}`;
    for (const [dt, part] of byDate) {
      const dir = path.join(this.tableDir(), `dt=${dt}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `part-${batchId}.ndjson`);
      fs.writeFileSync(file, part.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    this.setWatermark(rows[rows.length - 1].id);
    return { exported: rows.length, partitions: [...byDate.keys()].sort() };
  }

  listPartitions(): string[] {
    if (!fs.existsSync(this.tableDir())) return [];
    return fs
      .readdirSync(this.tableDir())
      .filter((d) => d.startsWith("dt="))
      .map((d) => d.slice(3))
      .sort();
  }

  /** Scan only partitions within [from, to] (partition pruning). */
  query(q: LakeQuery = {}): TelemetryRow[] {
    const out: TelemetryRow[] = [];
    for (const dt of this.listPartitions()) {
      if (q.from && dt < q.from.slice(0, 10)) continue;
      if (q.to && dt > q.to.slice(0, 10)) continue;
      const dir = path.join(this.tableDir(), `dt=${dt}`);
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"))) {
        for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
          if (!line) continue;
          const row = JSON.parse(line) as TelemetryRow;
          if (q.meterId && row.meter_id !== q.meterId) continue;
          if (q.from && row.received_at < q.from) continue;
          if (q.to && row.received_at.slice(0, q.to.length) > q.to) continue;
          out.push(row);
        }
      }
    }
    return out;
  }

  /** Per-meter aggregates over a query range. */
  summarize(q: LakeQuery = {}): LakeSummary[] {
    const acc = new Map<string, { events: number; units: number; cost: bigint }>();
    for (const r of this.query(q)) {
      const a = acc.get(r.meter_id) ?? { events: 0, units: 0, cost: 0n };
      a.events += 1;
      a.units += r.units;
      a.cost += BigInt(r.cost);
      acc.set(r.meter_id, a);
    }
    return [...acc].map(([meterId, a]) => ({
      meterId,
      events: a.events,
      totalUnits: a.units,
      totalCost: a.cost.toString(),
    }));
  }

  /** Retention: drop partitions older than `retentionDays`. */
  applyRetention(now = new Date()): string[] {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const removed = this.listPartitions().filter((dt) => dt < cutoff);
    for (const dt of removed) {
      fs.rmSync(path.join(this.tableDir(), `dt=${dt}`), { recursive: true, force: true });
    }
    return removed;
  }
}

export const dataLake = new DataLake();

/** Periodically run ETL + retention against the usage-events database. */
export function startDataLakeWorker(db: Database.Database) {
  const interval = Number(process.env.LAKE_ETL_INTERVAL_MS ?? 3_600_000);
  const tick = () => {
    try {
      let r;
      do r = dataLake.runEtl(db);
      while (r.exported > 0);
      dataLake.applyRetention();
    } catch (err) {
      console.error("data lake ETL failed", err);
    }
  };
  tick();
  return setInterval(tick, interval);
}
