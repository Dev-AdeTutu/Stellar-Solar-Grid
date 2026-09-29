import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { sendEmail, type EmailAttachment, type EmailResult } from "./mailer.js";

export const EMAIL_EVENTS = ["trades", "low_balance", "price_alerts", "billing"] as const;
export type EmailEvent = (typeof EMAIL_EVENTS)[number];

const DB_PATH = process.env.EMAIL_PREFERENCES_DB_PATH ?? path.resolve(process.cwd(), "data", "email-preferences.sqlite");
const TOKEN_SECRET = process.env.EMAIL_PREFERENCES_SECRET ?? process.env.ADMIN_SECRET_KEY ?? "";
let database: Database.Database | undefined;

function db(): Database.Database {
  if (!database) {
    database = new Database(DB_PATH);
    database.exec(`CREATE TABLE IF NOT EXISTS email_preferences (
      email TEXT NOT NULL,
      event TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (email, event)
    )`);
  }
  return database;
}

registerDatabase("email-preferences", () => {
  database?.close();
  database = undefined;
});

export function createEmailPreferenceToken(email: string): string {
  if (!TOKEN_SECRET) throw new Error("EMAIL_PREFERENCES_SECRET or ADMIN_SECRET_KEY must be configured");
  const payload = Buffer.from(email.trim().toLowerCase()).toString("base64url");
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyEmailPreferenceToken(token: string): string | undefined {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !TOKEN_SECRET) return undefined;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return undefined;
  const email = Buffer.from(payload, "base64url").toString("utf8");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

export function getEmailPreferences(email: string): Record<EmailEvent, boolean> {
  const preferences = Object.fromEntries(EMAIL_EVENTS.map((event) => [event, true])) as Record<EmailEvent, boolean>;
  const rows = db().prepare("SELECT event, enabled FROM email_preferences WHERE email = ?").all(email.trim().toLowerCase()) as Array<{event: string; enabled: number}>;
  for (const row of rows) {
    if (EMAIL_EVENTS.includes(row.event as EmailEvent)) preferences[row.event as EmailEvent] = row.enabled === 1;
  }
  return preferences;
}

export function setEmailPreference(email: string, event: EmailEvent, enabled: boolean): void {
  db().prepare(`INSERT INTO email_preferences (email, event, enabled, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(email, event) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run(email.trim().toLowerCase(), event, enabled ? 1 : 0, new Date().toISOString());
}

export function unsubscribeEmail(email: string): void {
  const statement = db().prepare(`INSERT INTO email_preferences (email, event, enabled, updated_at) VALUES (?, ?, 0, ?)
    ON CONFLICT(email, event) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at`);
  const now = new Date().toISOString();
  for (const event of EMAIL_EVENTS) statement.run(email.trim().toLowerCase(), event, now);
}

export async function sendNotificationEmail(input: {
  to: string;
  event: EmailEvent;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}): Promise<EmailResult> {
  if (!getEmailPreferences(input.to)[input.event]) return { delivered: false, provider: "preference-disabled" };
  const token = createEmailPreferenceToken(input.to);
  const baseUrl = (process.env.EMAIL_PREFERENCES_BASE_URL ?? process.env.BACKEND_PUBLIC_URL ?? process.env.PUBLIC_APP_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const unsubscribeUrl = `${baseUrl}/api/email-notifications/unsubscribe?token=${encodeURIComponent(token)}`;
  const preferencesUrl = `${baseUrl}/api/email-notifications/manage?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to: input.to,
    subject: input.subject,
    text: `${input.text}\n\nEmail preferences: ${preferencesUrl}\nUnsubscribe: ${unsubscribeUrl}`,
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px;font-family:Arial,sans-serif;color:#222"><main style="max-width:600px;margin:0 auto;line-height:1.5">${input.html}<hr><p><a href="${preferencesUrl}">Email preferences</a> | <a href="${unsubscribeUrl}">Unsubscribe</a></p></main></body></html>`,
    attachments: input.attachments,
  });
}