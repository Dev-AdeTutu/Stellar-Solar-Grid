import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type SupportTicket = {
  id: number;
  user: string;
  userEmail: string | null;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
};

type TicketRow = {
  id: number;
  user_address: string;
  user_email: string | null;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  created_at: string;
  updated_at: string;
};

const DB_PATH = process.env.SUPPORT_TICKETS_DB_PATH ?? path.resolve(process.cwd(), "data", "support-tickets.sqlite");
if (DB_PATH !== ":memory:") mkdirSync(path.dirname(DB_PATH), { recursive: true });
const database = new Database(DB_PATH);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_address TEXT NOT NULL,
    user_email TEXT,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_support_tickets_user_created
    ON support_tickets (user_address, created_at DESC);
`);
registerDatabase("support-tickets", () => database.close());

function toTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    user: row.user_address,
    userEmail: row.user_email,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTicket(input: {
  user: string;
  userEmail?: string | null;
  subject: string;
  description: string;
  priority?: TicketPriority;
}): SupportTicket {
  const now = new Date().toISOString();
  const result = database
    .prepare(
      `INSERT INTO support_tickets
       (user_address, user_email, subject, description, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .run(input.user, input.userEmail ?? null, input.subject, input.description, input.priority ?? "normal", now, now);
  return getTicket(Number(result.lastInsertRowid))!;
}

export function listTicketsForUser(user: string): SupportTicket[] {
  const rows = database
    .prepare("SELECT * FROM support_tickets WHERE user_address = ? ORDER BY created_at DESC, id DESC")
    .all(user) as TicketRow[];
  return rows.map(toTicket);
}

export function getTicket(id: number): SupportTicket | null {
  const row = database.prepare("SELECT * FROM support_tickets WHERE id = ?").get(id) as TicketRow | undefined;
  return row ? toTicket(row) : null;
}

export function updateTicketStatus(id: number, user: string, status: TicketStatus): SupportTicket | null {
  const updatedAt = new Date().toISOString();
  const result = database
    .prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ? AND user_address = ?")
    .run(status, updatedAt, id, user);
  return result.changes === 0 ? null : getTicket(id);
}

export function closeSupportTicketsStore(): void {
  if (database.open) database.close();
}
