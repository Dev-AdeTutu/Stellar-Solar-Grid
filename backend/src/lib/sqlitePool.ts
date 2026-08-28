import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * A bounded pool of `better-sqlite3` connections (Issue #735).
 *
 * The existing service opened a single handle per database and every operation
 * serialized through it. That works, but it means each module pins one file
 * handle for its whole life and any per-operation open/close pattern (seen in
 * some call sites before this change) pays file-lock + context-switch overhead
 * on every request.
 *
 * better-sqlite3 is synchronous, so a "pool" here means a small set of reuseable
 * connections that are handed out round-robin and returned after each unit of
 * work — eliminating per-operation open/close while keeping the WAL-enabled
 * database read-heavy friendly.
 *
 * Behaviour notes:
 * - `:memory:` databases cannot be shared across connections (each handle owns
 *   a private in-memory DB), so in-memory pools degrade to a single shared
 *   connection — preserving the previous semantics for tests and dev.
 * - The first connection opened is the "primary" handle, exposed via
 *   `primary()` for schema lifecycle and for callers that need raw access
 *   (e.g. `initUsageEventStore()`). Pooled operations use the remaining
 *   connections.
 * - Idle connections are pinged (`SELECT 1`) when they exceed `idleTimeoutMs`
 *   and transparently reopened if they have gone stale.
 * - `acquire()` waits up to `acquireTimeoutMs` before throwing, so a sudden
 *   burst cannot hold the event loop hostage.
 */

export type SqliteConnection = any;

export type SqlitePoolOptions = {
  filename: string;
  /** Minimum connections to keep open (file pools default: 2). */
  min?: number;
  /** Maximum connections to ever open (file pools default: 10). */
  max?: number;
  /** A connection idle longer than this is health-checked before reuse. */
  idleTimeoutMs?: number;
  /** How long `acquire()` waits for a free connection before failing. */
  acquireTimeoutMs?: number;
  /** Runs once per freshly opened connection (schema DDL, pragmas, …). */
  onCreate?: (database: SqliteConnection) => void;
};

export type SqlitePoolStats = {
  size: number;
  active: number;
  idle: number;
  min: number;
  max: number;
  singleConnectionMode: boolean;
};

export type SqlitePool = {
  /** The first/lifetime handle; excluded from round-robin in file pools. */
  primary: () => SqliteConnection;
  /** Check out a connection for a synchronous unit of work. */
  acquire: () => SqliteConnection;
  /** Return a checked-out connection to the pool. */
  release: (connection: SqliteConnection) => void;
  /** Close every pooled connection. Safe to call multiple times. */
  drain: () => void;
  getStats: () => SqlitePoolStats;
};

const DEFAULT_MIN = 2;
const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleepSync(ms: number): void {
  // Synchronous sleep without blocking timers/IO: a fast re-poll of the pool.
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleep, 0, 0, ms);
}

export function createSqlitePool(options: SqlitePoolOptions): SqlitePool {
  const filename = options.filename;
  const singleConnectionMode = filename === ":memory:";

  const min = singleConnectionMode
    ? 1
    : Math.max(1, options.min ?? readEnvInt("SQLITE_POOL_MIN", DEFAULT_MIN));
  const max = singleConnectionMode
    ? 1
    : Math.max(min, options.max ?? readEnvInt("SQLITE_POOL_MAX", DEFAULT_MAX));
  const idleTimeoutMs =
    options.idleTimeoutMs ?? readEnvInt("SQLITE_POOL_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
  const acquireTimeoutMs =
    options.acquireTimeoutMs ??
    readEnvInt("SQLITE_POOL_ACQUIRE_TIMEOUT_MS", DEFAULT_ACQUIRE_TIMEOUT_MS);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connections: SqliteConnection[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const used = new Set<SqliteConnection>();
  const lastUsedAt = new WeakMap<object, number>();
  let closed = false;

  // Warm up the minimum connections immediately so the pool is healthy before
  // the first request arrives (schema DDL runs here, exactly once per handle).
  for (let i = 0; i < min; i++) {
    openConnection();
  }

  function openConnection(): SqliteConnection {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    const database = new Database(filename);
    options.onCreate?.(database);
    connections.push(database);
    lastUsedAt.set(database, Date.now());
    return database;
  }

  function isHealthy(connection: SqliteConnection): boolean {
    try {
      connection.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  function closeAndRemove(connection: SqliteConnection): void {
    const index = connections.indexOf(connection);
    try {
      connection.close();
    } catch {
      // A stale handle may already be half-closed — continue cleanup.
    }
    if (index >= 0) connections.splice(index, 1);
    used.delete(connection);
  }

  function acquire(): SqliteConnection {
    if (closed) {
      throw new Error("SQLite pool has been drained and cannot accept more work");
    }

    const deadline = Date.now() + acquireTimeoutMs;

    for (;;) {
      if (singleConnectionMode) {
        const connection = connections[0]!;
        if (!isHealthy(connection)) {
          closeAndRemove(connection);
          const fresh = openConnection();
          lastUsedAt.set(fresh, Date.now());
          return fresh;
        }
        lastUsedAt.set(connection, Date.now());
        return connection;
      }

      // Prefer the least-recently-used idle connection. Index 0 is the
      // primary/lifetime handle, reserved for raw-access callers.
      const idle = connections.filter((c, index) => index !== 0 && !used.has(c));
      if (idle.length > 0) {
        idle.sort(
          (a, b) => (lastUsedAt.get(a) ?? 0) - (lastUsedAt.get(b) ?? 0),
        );
        const connection = idle[0]!;
        if (Date.now() - (lastUsedAt.get(connection) ?? 0) > idleTimeoutMs) {
          if (!isHealthy(connection)) {
            closeAndRemove(connection);
            const fresh = openConnection();
            used.add(fresh);
            lastUsedAt.set(fresh, Date.now());
            return fresh;
          }
        }
        used.add(connection);
        lastUsedAt.set(connection, Date.now());
        return connection;
      }

      if (connections.length < max) {
        const fresh = openConnection();
        used.add(fresh);
        lastUsedAt.set(fresh, Date.now());
        return fresh;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `SQLite connection pool exhausted (max=${max}) after ${acquireTimeoutMs}ms — ` +
            `reduce load or raise SQLITE_POOL_MAX`,
        );
      }
      sleepSync(5);
    }
  }

  function release(connection: SqliteConnection): void {
    if (closed || singleConnectionMode) return;
    used.delete(connection);
    lastUsedAt.set(connection, Date.now());
  }

  function drain(): void {
    if (closed) return;
    closed = true;
    for (const connection of connections.splice(0)) {
      try {
        connection.close();
      } catch {
        // Shutdown must continue closing the remaining handles.
      }
    }
    used.clear();
  }

  function getStats(): SqlitePoolStats {
    const active = connections.filter((c) => used.has(c)).length;
    return {
      size: connections.length,
      active,
      idle: connections.length - active,
      min,
      max,
      singleConnectionMode,
    };
  }

  return {
    primary: () => connections[0]!,
    acquire,
    release,
    drain,
    getStats,
  };
}