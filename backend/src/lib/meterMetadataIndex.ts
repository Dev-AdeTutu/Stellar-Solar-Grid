import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { SqlitePool } from "./sqlitePool.js";
import type Database from "better-sqlite3";

const DB_PATH =
  process.env.METER_METADATA_DB_PATH ??
  path.resolve(process.cwd(), "data", "meter-metadata.sqlite");

export type MeterLocationRecord = {
  meter_id: string;
  location: string;
  metadata?: string | null;
  updated_at: string;
};

export type ContractEventRecord = {
  id: number;
  event_type: string;
  meter_id: string | null;
  details: string | null;
  transaction_hash: string;
  ledger: number | null;
  timestamp: string;
};

export type ContractEventFilter = {
  eventType?: string;
  meterId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type ProviderMeterRecord = {
  meter_id: string;
  provider_id: string;
  location: string;
  status: string;
  metadata: string | null;
  updated_at: string;
};

export type ProviderFleetOverview = {
  totalMeters: number;
  activeMeters: number;
  inactiveMeters: number;
  totalUsage: number;
};

export type ProviderRevenuePoint = {
  period: string;
  revenue: number;
  usage: number;
};

const pool = new SqlitePool({
  filename: DB_PATH,
  min: 1,
  max: 5,
  onOpen: applySchema,
});

function applySchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meter_metadata_index (
      meter_id TEXT PRIMARY KEY,
      location TEXT NOT NULL COLLATE NOCASE,
      metadata TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_meter_metadata_location
      ON meter_metadata_index (location COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS contract_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      meter_id TEXT,
      details TEXT,
      transaction_hash TEXT NOT NULL,
      ledger INTEGER,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contract_events_type
      ON contract_events (event_type);

    CREATE INDEX IF NOT EXISTS idx_contract_events_meter
      ON contract_events (meter_id);

    CREATE INDEX IF NOT EXISTS idx_contract_events_timestamp
      ON contract_events (timestamp);

    CREATE TABLE IF NOT EXISTS provider_meters (
      meter_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      location TEXT NOT NULL COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_provider_meters_provider
      ON provider_meters (provider_id);

    CREATE INDEX IF NOT EXISTS idx_provider_meters_status
      ON provider_meters (provider_id, status);
  `);
}

registerDatabase("meter-metadata-index", () => {
  pool.drain();
});

pool.warm();

/**
 * Index or update the metadata location for a meter in SQLite.
 */
export function indexMeterLocation(
  meterId: string,
  location: string,
  metadata?: Record<string, any> | null
): void {
  pool.write((db) => {
    db.prepare(`
      INSERT OR REPLACE INTO meter_metadata_index (meter_id, location, metadata, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      meterId,
      location,
      metadata ? JSON.stringify(metadata) : null,
      new Date().toISOString()
    );
  });
}

/**
 * Look up the indexed location for a meter.
 */
export function getMeterLocationIndex(meterId: string): string | null {
  const db = pool.primaryDb();
  const row = db
    .prepare("SELECT location FROM meter_metadata_index WHERE meter_id = ?")
    .get(meterId) as { location: string } | undefined;
  return row ? row.location : null;
}

/**
 * Search indexed meters by location using case-insensitive partial match.
 */
export function searchMetersByLocationIndex(
  locationQuery: string,
  limit: number = 20,
  offset: number = 0
): { results: MeterLocationRecord[]; total: number } {
  const db = pool.primaryDb();
  const searchPattern = `%${locationQuery}%`;

  const countRow = db
    .prepare("SELECT COUNT(*) as count FROM meter_metadata_index WHERE location LIKE ?")
    .get(searchPattern) as { count: number };

  const rows = db
    .prepare(`
      SELECT meter_id, location, metadata, updated_at
      FROM meter_metadata_index
      WHERE location LIKE ?
      ORDER BY meter_id ASC
      LIMIT ? OFFSET ?
    `)
    .all(searchPattern, limit, offset) as MeterLocationRecord[];

  return { results: rows, total: countRow.count };
}

/**
 * Index a smart contract event for the events dashboard.
 */
export function indexContractEvent(event: {
  eventType: string;
  meterId?: string | null;
  details?: Record<string, any> | string | null;
  transactionHash: string;
  ledger?: number | null;
  timestamp?: string;
}): void {
  const details =
    event.details == null
      ? null
      : typeof event.details === "string"
        ? event.details
        : JSON.stringify(event.details);

  pool.write((db) => {
    db.prepare(`
      INSERT INTO contract_events
        (event_type, meter_id, details, transaction_hash, ledger, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventType,
      event.meterId ?? null,
      details,
      event.transactionHash,
      event.ledger ?? null,
      event.timestamp ?? new Date().toISOString()
    );
  });
}

/**
 * Query indexed contract events with optional filtering and pagination.
 */
export function queryContractEvents(filter: ContractEventFilter = {}): {
  results: ContractEventRecord[];
  total: number;
} {
  const db = pool.primaryDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.eventType) {
    conditions.push("event_type = ?");
    params.push(filter.eventType);
  }
  if (filter.meterId) {
    conditions.push("meter_id = ?");
    params.push(filter.meterId);
  }
  if (filter.from) {
    conditions.push("timestamp >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    conditions.push("timestamp <= ?");
    params.push(filter.to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM contract_events ${where}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(`
      SELECT id, event_type, meter_id, details, transaction_hash, ledger, timestamp
      FROM contract_events
      ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as ContractEventRecord[];

  return { results: rows, total: countRow.count };
}

/**
 * Register or update a meter owned by a provider.
 */
export function upsertProviderMeter(input: {
  meterId: string;
  providerId: string;
  location: string;
  status?: string;
  metadata?: Record<string, any> | null;
}): void {
  pool.write((db) => {
    db.prepare(`
      INSERT INTO provider_meters (meter_id, provider_id, location, status, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(meter_id) DO UPDATE SET
        provider_id = excluded.provider_id,
        location = excluded.location,
        status = excluded.status,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      input.meterId,
      input.providerId,
      input.location,
      input.status ?? "active",
      input.metadata ? JSON.stringify(input.metadata) : null,
      new Date().toISOString()
    );
  });
}

/**
 * List meters belonging to a provider with optional status filter and pagination.
 */
export function listProviderMeters(
  providerId: string,
  options: { status?: string; limit?: number; offset?: number } = {}
): { results: ProviderMeterRecord[]; total: number } {
  const db = pool.primaryDb();
  const conditions: string[] = ["provider_id = ?"];
  const params: any[] = [providerId];

  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM provider_meters ${where}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(`
      SELECT meter_id, provider_id, location, status, metadata, updated_at
      FROM provider_meters
      ${where}
      ORDER BY meter_id ASC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as ProviderMeterRecord[];

  return { results: rows, total: countRow.count };
}

/**
 * Compute fleet overview analytics for a provider.
 */
export function getProviderFleetOverview(providerId: string): ProviderFleetOverview {
  const db = pool.primaryDb();
  const row = db
    .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) as inactive
      FROM provider_meters
      WHERE provider_id = ?
    `)
    .get(providerId) as { total: number; active: number | null; inactive: number | null };

  const usageRow = db
    .prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(details, '$.usage') AS REAL)), 0) as usage
      FROM contract_events
      WHERE event_type = 'usage'
        AND meter_id IN (SELECT meter_id FROM provider_meters WHERE provider_id = ?)
    `)
    .get(providerId) as { usage: number | null };

  return {
    totalMeters: row.total ?? 0,
    activeMeters: row.active ?? 0,
    inactiveMeters: row.inactive ?? 0,
    totalUsage: usageRow.usage ?? 0,
  };
}

/**
 * Bulk update the status of multiple provider meters.
 */
export function bulkUpdateProviderMeterStatus(
  providerId: string,
  meterIds: string[],
  status: string
): number {
  if (meterIds.length === 0) return 0;
  const db = pool.primaryDb();
  const placeholders = meterIds.map(() => "?").join(", ");
  const result = db
    .prepare(`
      UPDATE provider_meters
      SET status = ?, updated_at = ?
      WHERE provider_id = ? AND meter_id IN (${placeholders})
    `)
    .run(status, new Date().toISOString(), providerId, ...meterIds);
  return result.changes;
}

/**
 * Bulk merge metadata into multiple provider meters.
 */
export function bulkUpdateProviderMeterMetadata(
  providerId: string,
  meterIds: string[],
  metadata: Record<string, any>
): number {
  if (meterIds.length === 0) return 0;
  const db = pool.primaryDb();
  const placeholders = meterIds.map(() => "?").join(", ");
  const result = db
    .prepare(`
      UPDATE provider_meters
      SET metadata = json_patch(COALESCE(metadata, '{}'), ?), updated_at = ?
      WHERE provider_id = ? AND meter_id IN (${placeholders})
    `)
    .run(JSON.stringify(metadata), new Date().toISOString(), providerId, ...meterIds);
  return result.changes;
}

/**
 * Aggregate monthly revenue and usage analytics for a provider.
 */
export function getProviderRevenueAnalytics(
  providerId: string,
  options: { from?: string; to?: string } = {}
): ProviderRevenuePoint[] {
  const db = pool.primaryDb();
  const conditions: string[] = [
    "event_type = 'usage'",
    "meter_id IN (SELECT meter_id FROM provider_meters WHERE provider_id = ?)",
  ];
  const params: any[] = [providerId];

  if (options.from) {
    conditions.push("timestamp >= ?");
    params.push(options.from);
  }
  if (options.to) {
    conditions.push("timestamp <= ?");
    params.push(options.to);
  }

  const rows = db
    .prepare(`
      SELECT
        substr(timestamp, 1, 7) as period,
        COALESCE(SUM(CAST(json_extract(details, '$.revenue') AS REAL)), 0) as revenue,
        COALESCE(SUM(CAST(json_extract(details, '$.usage') AS REAL)), 0) as usage
      FROM contract_events
      WHERE ${conditions.join(" AND ")}
      GROUP BY period
      ORDER BY period ASC
    `)
    .all(...params) as ProviderRevenuePoint[];

  return rows;
}

/**
 * Helper to extract location string from various formats of meter objects.
 */
export function extractLocation(meter: any): string | null {
  if (!meter) return null;
  if (typeof meter.location === "string" && meter.location.trim()) {
    return meter.location.trim();
  }
  if (meter.metadata) {
    if (typeof meter.metadata === "object") {
      if (meter.metadata instanceof Map) {
        const val = meter.metadata.get("location");
        if (typeof val === "string" && val.trim()) return val.trim();
      }
      if (Array.isArray(meter.metadata)) {
        const pair = meter.metadata.find(
          ([k]: [any, any]) => String(k).toLowerCase() === "location"
        );
        if (pair && typeof pair[1] === "string" && pair[1].trim()) {
          return pair[1].trim();
        }
      }
      if (typeof meter.metadata.location === "string" && meter.metadata.location.trim()) {
        return meter.metadata.location.trim();
      }
    }
  }
  const id = meter.id ?? meter.meter_id;
  if (id && typeof id === "string") {
    return getMeterLocationIndex(id);
  }
  return null;
}
