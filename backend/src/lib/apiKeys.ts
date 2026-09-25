/**
 * Provider API key management (#833).
 *
 * Keys are generated as `sg_<32 random bytes hex>`; only a SHA-256 hash is
 * persisted, so the plaintext key is returned exactly once at creation.
 */
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";

const DB_PATH =
  process.env.API_KEYS_DB_PATH ?? path.resolve(process.cwd(), "data", "api-keys.sqlite");

export type ApiKeyPermission = "read" | "write" | "admin";
export const API_KEY_PERMISSIONS: ApiKeyPermission[] = ["read", "write", "admin"];

export type ApiKeyRecord = {
  id: string;
  provider_id: string;
  name: string | null;
  key_prefix: string;
  permissions: ApiKeyPermission[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

type ApiKeyRow = Omit<ApiKeyRecord, "permissions"> & { permissions: string; key_hash: string };

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        name TEXT,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        permissions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys (provider_id);
    `);
  }
  return _db;
}

registerDatabase("api-keys", () => {
  _db?.close();
  _db = undefined;
});

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  const { key_hash: _hash, ...rest } = row;
  return { ...rest, permissions: JSON.parse(row.permissions) };
}

export function generateApiKey(input: {
  providerId: string;
  name?: string;
  permissions?: ApiKeyPermission[];
  expiresInDays?: number;
}): { key: string; record: ApiKeyRecord } {
  const key = `sg_${crypto.randomBytes(32).toString("hex")}`;
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = input.expiresInDays
    ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString()
    : null;
  const permissions = input.permissions?.length ? input.permissions : ["read"];
  db()
    .prepare(
      `INSERT INTO api_keys (id, provider_id, name, key_hash, key_prefix, permissions, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.providerId,
      input.name ?? null,
      hashApiKey(key),
      key.slice(0, 10),
      JSON.stringify(permissions),
      now.toISOString(),
      expiresAt,
    );
  return { key, record: getApiKey(id)! };
}

export function getApiKey(id: string): ApiKeyRecord | undefined {
  const row = db().prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function listApiKeys(providerId: string): ApiKeyRecord[] {
  const rows = db()
    .prepare("SELECT * FROM api_keys WHERE provider_id = ? ORDER BY created_at DESC")
    .all(providerId) as ApiKeyRow[];
  return rows.map(toRecord);
}

/** Revoke a key owned by `providerId`. Returns false if not found / not owned. */
export function revokeApiKey(providerId: string, id: string): boolean {
  const result = db()
    .prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND provider_id = ? AND revoked_at IS NULL",
    )
    .run(new Date().toISOString(), id, providerId);
  return result.changes > 0;
}

/** Validate a plaintext key. Returns the record if active, unexpired and unrevoked. */
export function validateApiKey(key: string, now = new Date()): ApiKeyRecord | undefined {
  const row = db().prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hashApiKey(key)) as
    | ApiKeyRow
    | undefined;
  if (!row || row.revoked_at) return undefined;
  if (row.expires_at && new Date(row.expires_at) <= now) return undefined;
  db().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
  return toRecord({ ...row, last_used_at: now.toISOString() });
}
