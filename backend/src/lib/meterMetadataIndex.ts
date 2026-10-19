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

export type MeterFirmwareRecord = {
  meter_id: string;
  firmware_version: string;
  updated_at: string;
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

    CREATE TABLE IF NOT EXISTS meter_firmware_index (
      meter_id TEXT PRIMARY KEY,
      firmware_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
 * Store or update the reported firmware version for a meter.
 */
export function indexMeterFirmware(meterId: string, firmwareVersion: string): void {
  pool.write((db) => {
    db.prepare(`
      INSERT OR REPLACE INTO meter_firmware_index (meter_id, firmware_version, updated_at)
      VALUES (?, ?, ?)
    `).run(meterId, firmwareVersion, new Date().toISOString());
  });
}

/**
 * Look up the stored firmware version for a meter.
 */
export function getMeterFirmwareVersion(meterId: string): string | null {
  const db = pool.primaryDb();
  const row = db
    .prepare("SELECT firmware_version FROM meter_firmware_index WHERE meter_id = ?")
    .get(meterId) as { firmware_version: string } | undefined;
  return row ? row.firmware_version : null;
}

/**
 * List all meters with their stored firmware versions.
 */
export function listMeterFirmwareVersions(): MeterFirmwareRecord[] {
  const db = pool.primaryDb();
  return db
    .prepare(`
      SELECT meter_id, firmware_version, updated_at
      FROM meter_firmware_index
      ORDER BY meter_id ASC
    `)
    .all() as MeterFirmwareRecord[];
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
