/**
 * Emergency contact management (#1000).
 *
 * Lets a user register people to notify (name, phone and/or email,
 * relationship) and configure which critical events should trigger a
 * notification to each contact — a suspected tamper/theft alert, or an
 * extended meter outage. This is unrelated to the "emergency energy
 * sharing" pool in routes/emergency.ts (#893); these are personal contacts
 * for a single user's account, not a cross-user sharing feature.
 *
 * Storage follows the pooled better-sqlite3 pattern used by meterNotes.ts:
 * a bounded SqlitePool with a schema-migration `onOpen` hook and
 * registerDatabase() for graceful shutdown.
 */
import path from "node:path";
import { registerDatabase } from "./databaseLifecycle.js";
import { SqlitePool, type SqlitePoolStatus } from "./sqlitePool.js";
import { sendEmail } from "./mailer.js";
import { logger } from "./logger.js";
import type Database from "better-sqlite3";

const DB_PATH =
  process.env.EMERGENCY_CONTACTS_DB_PATH ??
  path.resolve(process.cwd(), "data", "emergency-contacts.sqlite");

export const EMERGENCY_EVENT_TYPES = ["tamper", "outage"] as const;
export type EmergencyEventType = (typeof EMERGENCY_EVENT_TYPES)[number];

export type EmergencyContactRecord = {
  id: number;
  user_address: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  notify_on_tamper: number;
  notify_on_outage: number;
  created_at: string;
};

export type EmergencyContact = {
  id: number;
  userAddress: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  notifyOnTamper: boolean;
  notifyOnOutage: boolean;
  createdAt: string;
};

const pool = new SqlitePool({
  filename: DB_PATH,
  min: Number(process.env.EMERGENCY_CONTACTS_POOL_MIN ?? 1),
  max: Number(process.env.EMERGENCY_CONTACTS_POOL_MAX ?? 5),
  idleTimeout: Number(process.env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  acquireTimeout: Number(process.env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10_000),
  onOpen: applyEmergencyContactsSchema,
});

function applyEmergencyContactsSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS emergency_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_address TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      relationship TEXT,
      notify_on_tamper INTEGER NOT NULL DEFAULT 1,
      notify_on_outage INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user
      ON emergency_contacts (user_address, created_at DESC);
  `);
}

registerDatabase("emergency-contacts", () => {
  pool.drain();
});

// Warm the primary connection so the schema bootstraps at startup.
pool.warm();

/** Read-path accessor — stable primary connection. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  return pool.primaryDb();
}

/** Close the emergency-contacts store during graceful application shutdown. */
export function closeEmergencyContactsStore(): void {
  pool.drain();
}

/** Expose pool status for health checks / monitoring. */
export function getEmergencyContactsPoolStatus(): SqlitePoolStatus {
  return pool.status();
}

function toContact(row: EmergencyContactRecord): EmergencyContact {
  return {
    id: row.id,
    userAddress: row.user_address,
    name: row.name,
    phone: row.phone,
    email: row.email,
    relationship: row.relationship,
    notifyOnTamper: row.notify_on_tamper === 1,
    notifyOnOutage: row.notify_on_outage === 1,
    createdAt: row.created_at,
  };
}

export type AddEmergencyContactInput = {
  userAddress: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  relationship?: string | null;
  notifyOnTamper?: boolean;
  notifyOnOutage?: boolean;
};

export function addEmergencyContact(input: AddEmergencyContactInput): EmergencyContact {
  const createdAt = new Date().toISOString();
  const notifyOnTamper = input.notifyOnTamper ?? true;
  const notifyOnOutage = input.notifyOnOutage ?? true;
  const id = pool.withConnection((database) =>
    Number(
      database
        .prepare(
          `INSERT INTO emergency_contacts
             (user_address, name, phone, email, relationship, notify_on_tamper, notify_on_outage, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.userAddress,
          input.name,
          input.phone ?? null,
          input.email ?? null,
          input.relationship ?? null,
          notifyOnTamper ? 1 : 0,
          notifyOnOutage ? 1 : 0,
          createdAt,
        ).lastInsertRowid,
    ),
  );

  return {
    id,
    userAddress: input.userAddress,
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    relationship: input.relationship ?? null,
    notifyOnTamper,
    notifyOnOutage,
    createdAt,
  };
}

export function listEmergencyContacts(userAddress: string): EmergencyContact[] {
  const rows = db()
    .prepare(
      `SELECT id, user_address, name, phone, email, relationship, notify_on_tamper, notify_on_outage, created_at
       FROM emergency_contacts
       WHERE user_address = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(userAddress) as EmergencyContactRecord[];
  return rows.map(toContact);
}

export function deleteEmergencyContact(userAddress: string, contactId: number): boolean {
  return pool.withConnection((database) => {
    const result = database
      .prepare(`DELETE FROM emergency_contacts WHERE id = ? AND user_address = ?`)
      .run(contactId, userAddress);
    return (result.changes as number) > 0;
  });
}

/** Internal helper so tests/consumers of notifyEmergencyContacts can see who would be notified. */
export function getContactsForEvent(
  userAddress: string,
  eventType: EmergencyEventType,
): EmergencyContact[] {
  const column = eventType === "tamper" ? "notify_on_tamper" : "notify_on_outage";
  const rows = db()
    .prepare(
      `SELECT id, user_address, name, phone, email, relationship, notify_on_tamper, notify_on_outage, created_at
       FROM emergency_contacts
       WHERE user_address = ? AND ${column} = 1`,
    )
    .all(userAddress) as EmergencyContactRecord[];
  return rows.map(toContact);
}

export type NotifyEmergencyContactsResult = {
  eventType: EmergencyEventType;
  userAddress: string;
  meterId: string;
  notified: Array<{ contactId: number; channel: "email" | "log-only"; delivered: boolean }>;
};

const EVENT_LABEL: Record<EmergencyEventType, string> = {
  tamper: "a suspected tampering / energy theft alert",
  outage: "an extended power outage",
};

/**
 * Pure, well-tested notification entry point for #1000's "notify contacts on
 * critical events" requirement. Given a user's wallet/account address, the
 * triggering event type and the affected meter, this looks up that user's
 * emergency contacts, filters to only those with the matching notify_on_*
 * flag enabled, and sends a notification through the mailer (#902) for any
 * contact with an email on file.
 *
 * There is no outbound SMS transport in this codebase today — smsProviders.ts
 * only resolves a region's display shortcode, it does not send messages — so
 * phone-only contacts (or email delivery failures) are logged instead of
 * silently dropped, and reported back with channel: "log-only" so callers
 * (and tests) can see delivery wasn't guaranteed.
 *
 * Call-site hooks: theftDetection.ts's notifyAlert() and meterHealth.ts's
 * checkStaleMeters() invoke this once a tamper/outage condition is detected,
 * resolving the owning user_address via deviceRegistry.listDevices(). Kept as
 * a single hook per monitor (not a deep refactor) per #1000's guidance.
 */
export async function notifyEmergencyContacts(
  userAddress: string,
  eventType: EmergencyEventType,
  meterId: string,
): Promise<NotifyEmergencyContactsResult> {
  const contacts = getContactsForEvent(userAddress, eventType);
  const notified: NotifyEmergencyContactsResult["notified"] = [];

  for (const contact of contacts) {
    if (contact.email) {
      try {
        const result = await sendEmail({
          to: contact.email,
          subject: `SolarGrid emergency alert: ${EVENT_LABEL[eventType]}`,
          text: `Hi ${contact.name},\n\nYou're listed as an emergency contact for meter ${meterId}. We detected ${EVENT_LABEL[eventType]} on this account and wanted to let you know.\n\nThis is an automated notification from SolarGrid.`,
          html: `<p>Hi ${contact.name},</p><p>You're listed as an emergency contact for meter <strong>${meterId}</strong>. We detected ${EVENT_LABEL[eventType]} on this account and wanted to let you know.</p><p>This is an automated notification from SolarGrid.</p>`,
        });
        notified.push({ contactId: contact.id, channel: "email", delivered: result.delivered });
      } catch (error) {
        logger.warn(
          { contactId: contact.id, eventType, meterId, error },
          "Emergency contact email notification failed",
        );
        notified.push({ contactId: contact.id, channel: "email", delivered: false });
      }
    } else {
      // Phone-only contact: no SMS transport exists in this codebase, so we
      // log the intent to notify rather than dropping it silently.
      logger.info(
        { contactId: contact.id, phone: contact.phone, eventType, meterId },
        "Emergency contact has no email on file; notification logged only (no SMS transport configured)",
      );
      notified.push({ contactId: contact.id, channel: "log-only", delivered: false });
    }
  }

  return { eventType, userAddress, meterId, notified };
}
