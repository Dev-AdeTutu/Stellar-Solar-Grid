/**
 * SMS notification preferences, rate limiting and dispatch (#997).
 *
 * Users without a smartphone are identified by phone number (E.164). SMS is
 * opt-in per event — unlike email, which is opt-out — since every message
 * costs money. A per-phone daily cap (SMS_MAX_PER_DAY) bounds the provider
 * bill regardless of how many events fire.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { sendSms, type SmsResult } from "./smsSender.js";

export const SMS_EVENTS = ["low_balance", "payment_received", "meter_issue"] as const;
export type SmsEvent = (typeof SMS_EVENTS)[number];

const DB_PATH = process.env.SMS_PREFERENCES_DB_PATH ?? path.resolve(process.cwd(), "data", "sms-preferences.sqlite");
const MAX_PER_DAY = Number(process.env.SMS_MAX_PER_DAY ?? 5);

const PHONE_RE = /^\+[1-9]\d{6,14}$/;
export function isValidPhone(phone: string): boolean {
  return PHONE_RE.test(phone);
}

type Db = InstanceType<typeof Database>;
let database: Db | undefined;

function db(): Db {
  if (!database) {
    database = new Database(DB_PATH);
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS sms_preferences (
        phone TEXT NOT NULL,
        event TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (phone, event)
      );
      CREATE TABLE IF NOT EXISTS sms_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        event TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sms_log_phone_sent ON sms_log (phone, sent_at);
    `);
  }
  return database;
}

registerDatabase("sms-preferences", () => {
  database?.close();
  database = undefined;
});

/** Opted-in events for a phone number; every event defaults to disabled until the user opts in. */
export function getSmsPreferences(phone: string): Record<SmsEvent, boolean> {
  const preferences = Object.fromEntries(SMS_EVENTS.map((event) => [event, false])) as Record<SmsEvent, boolean>;
  const rows = db().prepare("SELECT event, enabled FROM sms_preferences WHERE phone = ?").all(phone) as
    { event: string; enabled: number }[];
  for (const row of rows) {
    if (SMS_EVENTS.includes(row.event as SmsEvent)) preferences[row.event as SmsEvent] = row.enabled === 1;
  }
  return preferences;
}

export function setSmsPreference(phone: string, event: SmsEvent, enabled: boolean): void {
  db().prepare(
    `INSERT INTO sms_preferences (phone, event, enabled, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(phone, event) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(phone, event, enabled ? 1 : 0, new Date().toISOString());
}

export function setSmsPreferences(phone: string, patch: Partial<Record<SmsEvent, boolean>>): Record<SmsEvent, boolean> {
  for (const [event, enabled] of Object.entries(patch)) {
    if (SMS_EVENTS.includes(event as SmsEvent) && typeof enabled === "boolean") {
      setSmsPreference(phone, event as SmsEvent, enabled);
    }
  }
  return getSmsPreferences(phone);
}

/** Messages sent to this phone (any event) since midnight UTC. */
function sentToday(phone: string): number {
  const since = new Date().toISOString().slice(0, 10);
  const row = db().prepare("SELECT COUNT(*) AS n FROM sms_log WHERE phone = ? AND sent_at >= ?").get(phone, since) as { n: number };
  return row.n;
}

export type SmsNotificationResult =
  | { ok: true; result: SmsResult }
  | { ok: false; reason: "preference-disabled" | "rate-limited" };

/** Send an SMS for `event` if the user opted in and is under today's rate limit. */
export async function sendSmsNotification(input: { phone: string; event: SmsEvent; message: string }): Promise<SmsNotificationResult> {
  if (!getSmsPreferences(input.phone)[input.event]) return { ok: false, reason: "preference-disabled" };
  if (sentToday(input.phone) >= MAX_PER_DAY) return { ok: false, reason: "rate-limited" };
  const result = await sendSms({ to: input.phone, body: input.message });
  db().prepare("INSERT INTO sms_log (phone, event, sent_at) VALUES (?, ?, ?)").run(input.phone, input.event, new Date().toISOString());
  return { ok: true, result };
}
