import Database from 'better-sqlite3';
import { registerDatabase } from './database';
import { sendNotificationEmail } from './emailNotifications';

export type MaintenanceStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

export interface MaintenanceWindow {
  id: number;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  affected_meters: number[];
  status: MaintenanceStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateMaintenanceWindowInput {
  title: string;
  description?: string;
  starts_at: string;
  ends_at: string;
  affected_meters?: number[];
  status?: MaintenanceStatus;
}

export interface MaintenanceNotificationRecord {
  id: number;
  window_id: number;
  threshold: string;
  sent_at: string;
}

const NOTIFICATION_THRESHOLDS: Array<{ key: string; hours: number }> = [
  { key: '48h', hours: 48 },
  { key: '24h', hours: 24 },
  { key: '1h', hours: 1 },
];

let db: Database.Database | null = null;
let schedulerHandle: ReturnType<typeof setInterval> | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = registerDatabase('maintenance');
    db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        affected_meters TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS maintenance_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_id INTEGER NOT NULL,
        threshold TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        UNIQUE(window_id, threshold)
      );
    `);
  }
  return db;
}

function parseMeters(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => Number(v)).filter((v) => Number.isFinite(v));
      }
    } catch {
      return [];
    }
  }
  return [];
}

function rowToWindow(row: any): MaintenanceWindow {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    affected_meters: parseMeters(row.affected_meters),
    status: row.status as MaintenanceStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toIso(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed.toISOString();
}

export function createMaintenanceWindow(input: CreateMaintenanceWindowInput): MaintenanceWindow {
  const title = (input.title ?? '').trim();
  if (!title) {
    throw new Error('title is required');
  }
  if (!input.starts_at || !input.ends_at) {
    throw new Error('starts_at and ends_at are required');
  }

  const startsAt = toIso(input.starts_at);
  const endsAt = toIso(input.ends_at);

  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('ends_at must be after starts_at');
  }

  const now = new Date().toISOString();
  const meters = parseMeters(input.affected_meters ?? []);
  const status: MaintenanceStatus = input.status ?? 'scheduled';

  const database = getDb();
  const result = database
    .prepare(
      `INSERT INTO maintenance_windows
        (title, description, starts_at, ends_at, affected_meters, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      input.description ?? '',
      startsAt,
      endsAt,
      JSON.stringify(meters),
      status,
      now,
      now
    );

  const id = Number(result.lastInsertRowid);
  const created = getWindow(id);
  if (!created) {
    throw new Error('Failed to create maintenance window');
  }
  return created;
}

export function getWindow(id: number): MaintenanceWindow | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  return row ? rowToWindow(row) : null;
}

export function listUpcomingWindows(now: Date | string = new Date(), limit = 50): MaintenanceWindow[] {
  const nowIso = toIso(now);
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE status IN ('scheduled', 'active')
         AND ends_at > ?
       ORDER BY starts_at ASC
       LIMIT ?`
    )
    .all(nowIso, limit);
  return rows.map(rowToWindow);
}

export function getActiveWindow(now: Date | string = new Date()): MaintenanceWindow | null {
  const nowIso = toIso(now);
  const database = getDb();
  const row = database
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE status IN ('scheduled', 'active')
         AND starts_at <= ?
         AND ends_at > ?
       ORDER BY starts_at ASC
       LIMIT 1`
    )
    .get(nowIso, nowIso);
  return row ? rowToWindow(row) : null;
}

export function cancelWindow(id: number): MaintenanceWindow | null {
  const existing = getWindow(id);
  if (!existing) {
    return null;
  }
  const now = new Date().toISOString();
  const database = getDb();
  database
    .prepare('UPDATE maintenance_windows SET status = ?, updated_at = ? WHERE id = ?')
    .run('cancelled', now, id);
  return getWindow(id);
}

export function listAffectedMeters(windowId: number): number[] {
  const window = getWindow(windowId);
  return window ? window.affected_meters : [];
}

function hasNotificationBeenSent(windowId: number, threshold: string): boolean {
  const database = getDb();
  const row = database
    .prepare('SELECT 1 FROM maintenance_notifications WHERE window_id = ? AND threshold = ?')
    .get(windowId, threshold);
  return Boolean(row);
}

function recordNotification(windowId: number, threshold: string, sentAt: string): void {
  const database = getDb();
  database
    .prepare(
      `INSERT OR IGNORE INTO maintenance_notifications (window_id, threshold, sent_at)
       VALUES (?, ?, ?)`
    )
    .run(windowId, threshold, sentAt);
}

function getMeterOwnerEmail(meterId: number): string | null {
  try {
    const database = registerDatabase('meters');
    const row = database
      .prepare('SELECT owner_email FROM meters WHERE id = ?')
      .get(meterId) as { owner_email?: string } | undefined;
    if (row && row.owner_email) {
      return row.owner_email;
    }
  } catch {
    // meters table may not be available in all environments
  }
  return null;
}

export async function sendMaintenanceNotifications(now: Date | string = new Date()): Promise<number> {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Invalid date: ${now}`);
  }
  const nowIso = nowDate.toISOString();
  const database = getDb();

  const rows = database
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE status = 'scheduled'
         AND starts_at > ?
       ORDER BY starts_at ASC`
    )
    .all(nowIso);

  let sentCount = 0;

  for (const row of rows) {
    const window = rowToWindow(row);
    const startsAtMs = new Date(window.starts_at).getTime();
    const msUntilStart = startsAtMs - nowDate.getTime();

    for (const threshold of NOTIFICATION_THRESHOLDS) {
      const thresholdMs = threshold.hours * 60 * 60 * 1000;
      if (msUntilStart > thresholdMs || msUntilStart < 0) {
        continue;
      }
      if (hasNotificationBeenSent(window.id, threshold.key)) {
        continue;
      }

      const recipients = new Set<string>();
      for (const meterId of window.affected_meters) {
        const email = getMeterOwnerEmail(meterId);
        if (email) {
          recipients.add(email);
        }
      }

      for (const email of recipients) {
        try {
          await sendNotificationEmail({
            to: email,
            event: 'maintenance',
            data: {
              title: window.title,
              description: window.description,
              starts_at: window.starts_at,
              ends_at: window.ends_at,
              threshold: threshold.key,
              affected_meters: window.affected_meters,
            },
          });
        } catch {
          // continue sending to other recipients
        }
      }

      recordNotification(window.id, threshold.key, nowIso);
      sentCount += 1;
    }
  }

  return sentCount;
}

export function startMaintenanceScheduler(intervalMs = 15 * 60 * 1000): void {
  if (schedulerHandle) {
    return;
  }
  schedulerHandle = setInterval(() => {
    void sendMaintenanceNotifications(new Date()).catch(() => {
      // swallow scheduler errors
    });
  }, intervalMs);
  if (typeof (schedulerHandle as any).unref === 'function') {
    (schedulerHandle as any).unref();
  }
}

export function stopMaintenanceScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

export function _resetMaintenanceForTests(): void {
  stopMaintenanceScheduler();
  if (db) {
    try {
      db.exec('DELETE FROM maintenance_notifications');
      db.exec('DELETE FROM maintenance_windows');
    } catch {
      // ignore
    }
  }
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>