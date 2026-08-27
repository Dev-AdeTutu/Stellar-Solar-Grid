import { initUsageEventStore } from "./usageEvents.js";

export type PushSubscriptionRecord = {
  id: number;
  owner_address: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
};

type PushSubscriptionInput = {
  ownerAddress: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// Cast is aligned with usageEvents store typing in this codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

/**
 * Resolve the shared SQLite handle on first use rather than at import time.
 * Importing this module (via pushNotifications) must not force the usage-event
 * store open — doing so crashed as soon as anything loaded the module before
 * the store existed.
 */
function getDb() {
  if (!db) {
    db = initUsageEventStore();
    ensurePushSubscriptionTable();
  }
  return db;
}

function ensurePushSubscriptionTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_address TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_owner
      ON push_subscriptions (owner_address);
  `);
}

export function upsertPushSubscription(input: PushSubscriptionInput): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `
      INSERT INTO push_subscriptions (
        owner_address,
        endpoint,
        p256dh,
        auth,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        owner_address = excluded.owner_address,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = excluded.updated_at
    `,
  ).run(
    input.ownerAddress,
    input.endpoint,
    input.p256dh,
    input.auth,
    now,
    now,
  );
}

export function listPushSubscriptionsByOwner(ownerAddress: string): PushSubscriptionRecord[] {
  return getDb()
    .prepare(
      `
        SELECT
          id,
          owner_address,
          endpoint,
          p256dh,
          auth,
          created_at,
          updated_at
        FROM push_subscriptions
        WHERE owner_address = ?
      `,
    )
    .all(ownerAddress) as PushSubscriptionRecord[];
}

export function deletePushSubscriptionByEndpoint(endpoint: string): number {
  const result = getDb()
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .run(endpoint);
  return result.changes;
}
