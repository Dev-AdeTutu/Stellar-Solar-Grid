"use client";

// Persists mutating requests (e.g. a payment submission made while offline)
// in IndexedDB so they survive a page reload, and replays them once the
// browser reports it's back online. See docs/OFFLINE_MODE.md.

const DB_NAME = "solargrid-offline";
const STORE_NAME = "queued-actions";
const DB_VERSION = 1;

export interface QueuedAction {
  id?: number;
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  queuedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Queue a mutating request for later submission. Call this when a fetch fails while offline. */
export async function enqueueAction(action: Omit<QueuedAction, "id" | "queuedAt">): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({ ...action, queuedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listQueuedActions(): Promise<QueuedAction[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDb();
  const result = await new Promise<QueuedAction[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as QueuedAction[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

async function removeQueuedAction(id: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * Attempt to resubmit every queued action. Successfully-submitted actions are
 * removed from the queue; failures are left in place for the next attempt.
 * Returns the number of actions successfully flushed.
 */
export async function flushQueuedActions(): Promise<number> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;

  const actions = await listQueuedActions();
  let flushed = 0;
  for (const action of actions) {
    if (action.id === undefined) continue;
    try {
      const res = await fetch(action.url, {
        method: action.method,
        headers: action.headers,
        body: action.body,
      });
      if (res.ok) {
        await removeQueuedAction(action.id);
        flushed++;
      }
    } catch {
      // Still offline or backend unreachable — leave queued for next attempt.
      break;
    }
  }
  return flushed;
}
