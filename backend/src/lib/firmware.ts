import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { registerDatabase } from './database';

export type FirmwareUpdateStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'rolled_back';

export type RolloutStage = 10 | 50 | 100;

export interface FirmwareVersion {
  id: number;
  version: string;
  filename: string;
  checksum: string;
  size_bytes: number;
  uploaded_at: string;
  notes: string | null;
}

export interface FirmwareUpdate {
  id: number;
  meter_id: string;
  firmware_version_id: number;
  status: FirmwareUpdateStatus;
  rollout_stage: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  previous_version: string | null;
}

export interface StoreFirmwareInput {
  version: string;
  filename: string;
  data: Buffer | Uint8Array | string;
  notes?: string;
}

export interface FirmwareStatusPayload {
  status?: string;
  error?: string;
  version?: string;
}

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'data', 'firmware');

let db: Database.Database | null = null;

function ensureFirmwareDir(): void {
  if (!fs.existsSync(FIRMWARE_DIR)) {
    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
  }
}

function getDb(): Database.Database {
  if (db) {
    return db;
  }
  db = registerDatabase('firmware');
  db.exec(`
    CREATE TABLE IF NOT EXISTS firmware_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS firmware_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      firmware_version_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rollout_stage INTEGER NOT NULL DEFAULT 10,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      previous_version TEXT,
      FOREIGN KEY (firmware_version_id) REFERENCES firmware_versions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_firmware_updates_meter
      ON firmware_updates(meter_id);
    CREATE INDEX IF NOT EXISTS idx_firmware_updates_version
      ON firmware_updates(firmware_version_id);
  `);
  return db;
}

function computeChecksum(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'base64');
  }
  return Buffer.from(data);
}

export function storeFirmware(input: StoreFirmwareInput): FirmwareVersion {
  const database = getDb();
  ensureFirmwareDir();

  const buffer = toBuffer(input.data);
  const checksum = computeChecksum(buffer);
  const safeFilename = `${input.version}-${path.basename(input.filename)}`;
  const filePath = path.join(FIRMWARE_DIR, safeFilename);

  fs.writeFileSync(filePath, buffer);

  const uploadedAt = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO firmware_versions (version, filename, checksum, size_bytes, uploaded_at, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.version,
    safeFilename,
    checksum,
    buffer.length,
    uploadedAt,
    input.notes ?? null,
  );

  return {
    id: Number(result.lastInsertRowid),
    version: input.version,
    filename: safeFilename,
    checksum,
    size_bytes: buffer.length,
    uploaded_at: uploadedAt,
    notes: input.notes ?? null,
  };
}

export function listFirmwareVersions(): FirmwareVersion[] {
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM firmware_versions ORDER BY uploaded_at DESC, id DESC')
    .all() as FirmwareVersion[];
  return rows;
}

export function getFirmwareVersion(id: number): FirmwareVersion | null {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM firmware_versions WHERE id = ?')
    .get(id) as FirmwareVersion | undefined;
  return row ?? null;
}

export function getFirmwareVersionByVersion(version: string): FirmwareVersion | null {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM firmware_versions WHERE version = ?')
    .get(version) as FirmwareVersion | undefined;
  return row ?? null;
}

export function getFirmwareFilePath(version: FirmwareVersion): string {
  return path.join(FIRMWARE_DIR, version.filename);
}

export function createUpdate(
  meterId: string,
  versionId: number,
  previousVersion?: string | null,
): FirmwareUpdate {
  const database = getDb();

  const existing = database
    .prepare(
      `SELECT * FROM firmware_updates
       WHERE meter_id = ? AND firmware_version_id = ?
         AND status IN ('pending', 'in_progress')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(meterId, versionId) as FirmwareUpdate | undefined;

  if (existing) {
    return existing;
  }

  const stmt = database.prepare(`
    INSERT INTO firmware_updates
      (meter_id, firmware_version_id, status, rollout_stage, started_at, completed_at, error, previous_version)
    VALUES (?, ?, 'pending', 10, NULL, NULL, NULL, ?)
  `);
  const result = stmt.run(meterId, versionId, previousVersion ?? null);

  return {
    id: Number(result.lastInsertRowid),
    meter_id: meterId,
    firmware_version_id: versionId,
    status: 'pending',
    rollout_stage: 10,
    started_at: null,
    completed_at: null,
    error: null,
    previous_version: previousVersion ?? null,
  };
}

function deterministicBucket(meterId: string, versionId: number): number {
  const hash = crypto
    .createHash('sha256')
    .update(`${versionId}:${meterId}`)
    .digest();
  return hash.readUInt32BE(0) % 100;
}

export function selectMetersForRollout(
  versionId: number,
  stage: RolloutStage,
  eligibleMeterIds: string[],
): string[] {
  const database = getDb();

  const alreadyTargeted = new Set(
    (
      database
        .prepare(
          `SELECT meter_id FROM firmware_updates
           WHERE firmware_version_id = ? AND status IN ('pending', 'in_progress', 'success')`,
        )
        .all(versionId) as Array<{ meter_id: string }>
    ).map((r) => r.meter_id),
  );

  const selected: string[] = [];
  for (const meterId of eligibleMeterIds) {
    if (alreadyTargeted.has(meterId)) {
      continue;
    }
    if (deterministicBucket(meterId, versionId) < stage) {
      selected.push(meterId);
    }
  }
  return selected;
}

export function advanceRollout(versionId: number): RolloutStage {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT MAX(rollout_stage) AS stage FROM firmware_updates WHERE firmware_version_id = ?`,
    )
    .get(versionId) as { stage: number | null } | undefined;

  const current = (row?.stage ?? 10) as RolloutStage;
  let next: RolloutStage;
  if (current < 50) {
    next = 50;
  } else if (current < 100) {
    next = 100;
  } else {
    next = 100;
  }

  database
    .prepare(
      `UPDATE firmware_updates SET rollout_stage = ?
       WHERE firmware_version_id = ? AND status IN ('pending', 'in_progress')`,
    )
    .run(next, versionId);

  return next;
}

export function getRolloutStage(versionId: number): RolloutStage {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT MAX(rollout_stage) AS stage FROM firmware_updates WHERE firmware_version_id = ?`,
    )
    .get(versionId) as { stage: number | null } | undefined;
  return (row?.stage ?? 10) as RolloutStage;
}

export function recordUpdateStatus(
  meterId: string,
  status: FirmwareUpdateStatus,
  error?: string,
): FirmwareUpdate | null {
  const database = getDb();

  const existing = database
    .prepare(
      `SELECT * FROM firmware_updates
       WHERE meter_id = ? AND status IN ('pending', 'in_progress')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(meterId) as FirmwareUpdate | undefined;

  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  let startedAt = existing.started_at;
  let completedAt = existing.completed_at;

  if (status === 'in_progress' && !startedAt) {
    startedAt = now;
  }
  if (status === 'success' || status === 'failed' || status === 'rolled_back') {
    completedAt = now;
    if (!startedAt) {
      startedAt = now;
    }
  }

  database
    .prepare(
      `UPDATE firmware_updates
       SET status = ?, started_at = ?, completed_at = ?, error = ?
       WHERE id = ?`,
    )
    .run(status, startedAt, completedAt, error ?? null, existing.id);

  return {
    ...existing,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    error: error ?? null,
  };
}

export function rollbackUpdate(meterId: string): FirmwareUpdate | null {
  const database = getDb();

  const existing = database
    .prepare(
      `SELECT * FROM firmware_updates
       WHERE meter_id = ? AND status IN ('pending', 'in_progress', 'failed')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(meterId) as FirmwareUpdate | undefined;

  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE firmware_updates
       SET status = 'rolled_back', completed_at = ?, error = COALESCE(error, 'rollback')
       WHERE id = ?`,
    )
    .run(now, existing.id);

  return {
    ...existing,
    status: 'rolled_back',
    completed_at: now,
    error: existing.error ?? 'rollback',
  };
}

export function getUpdatesForMeter(meterId: string): FirmwareUpdate[] {
  const database = getDb();
  return database
    .prepare('SELECT * FROM firmware_updates WHERE meter_id = ? ORDER BY id DESC')
    .all(meterId) as FirmwareUpdate[];
}

export function getUpdatesForVersion(versionId: number): FirmwareUpdate[] {
  const database = getDb();
  return database
    .prepare('SELECT * FROM firmware_updates WHERE firmware_version_id = ? ORDER BY id DESC')
    .all(versionId) as FirmwareUpdate[];
}

export function handleFirmwareStatusMessage(
  meterId: string,
  payload: FirmwareStatusPayload | string,
): FirmwareUpdate | null {
  let parsed: FirmwareStatusPayload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as FirmwareStatusPayload;
    } catch {
      parsed = { status: payload };
    }
  } else {
    parsed = payload;
  }

  const rawStatus = (parsed.status || '').toLowerCase();

  if (rawStatus === 'success' || rawStatus === 'completed' || rawStatus === 'ok') {
    return recordUpdateStatus(meterId, 'success');
  }

  if (rawStatus === 'in_progress' || rawStatus === 'downloading' || rawStatus === 'installing') {
    return recordUpdateStatus(meterId, 'in_progress');
  }

  if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'failure') {
    recordUpdateStatus(meterId, 'failed', parsed.error);
    return rollbackUpdate(meterId);
  }

  return null;
}

export function resetFirmwareDatabase(): void {
  db = null;
}