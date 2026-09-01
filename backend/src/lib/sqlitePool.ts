import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * #735 — A small synchronous connection pool for better-sqlite3.
 *
 * better-sqlite3 is synchronous — a single thread can only be inside one
 * statement at a time — so this pool is not about "parallel queries". It is
 * about:
 *   - Keeping a warm set of connections open instead of opening/closing per
 *     operation, so the WAL checkpoint/read paths share stable handles and we
 *     avoid the file-open + schema-bootstrap cost on the hot path.
 *   - Bounding resource usage with min/max, idle eviction and acquire timeout.
 *   - Giving long-lived async workflows (usage-event submission loops) a
 *     dedicated connection while readers keep using the warm primary handle.
 *   - Exposing status for health checks and metrics.
 *
 * For `:memory:` databases a single connection is forced (a memory DB is
 * per-connection, so opening a pool would produce N unrelated databases).
 */

export type SqlitePoolConfig = {
  filename: string;
  /** Minimum warm connections kept open (default 2). */
  min?: number;
  /** Maximum connections ever opened (default 10). */
  max?: number;
  /** Close idle connections that have been idle at least this long when above min (default 30s). */
  idleTimeout?: number;
  /** How long to wait for a free connection when saturated (default 10s). */
  acquireTimeout?: number;
  /** busy_timeout pragma applied to every connection (default 5s). */
  busyTimeout?: number;
  /** Optional schema bootstrap run on every freshly opened connection. */
  onOpen?: (database: Database) => void;
};

export type SqlitePoolStatus = {
  filename: string;
  min: number;
  max: number;
  idleTimeout: number;
  acquireTimeout: number;
  busyTimeout: number;
  total: number;
  idle: number;
  busy: number;
  closed: boolean;
};

const DEFAULT_MIN = 2;
const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TIMEOUT = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT = 10_000;
const DEFAULT_BUSY_TIMEOUT = 5_000;

type ManagedConnection = {
  db: Database;
  busy: boolean;
  lastUsedAt: number;
};

const waitLock = new Int32Array(new SharedArrayBuffer(4));

/** Block the current synchronous thread for `ms` milliseconds. */
function idleSleep(ms: number): void {
  if (typeof Atomics !== "undefined" && typeof Atomics.wait === "function") {
    Atomics.wait(waitLock, 0, 0, ms);
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait fallback for environments without Atomics.wait
  }
}

export class SqlitePoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlitePoolError";
  }
}

export class SqlitePool {
  readonly filename: string;
  readonly min: number;
  readonly max: number;
  readonly idleTimeout: number;
  readonly acquireTimeout: number;
  readonly busyTimeout: number;
  private readonly onOpen?: (database: Database) => void;
  private connections: ManagedConnection[] = [];
  private primary: ManagedConnection | null = null;
  private closed = false;

  constructor(config: SqlitePoolConfig) {
    const isMemory = config.filename === ":memory:";
    this.filename = config.filename;

    if (isMemory) {
      // Each connection would be its own empty database — force a single handle.
      this.min = 1;
      this.max = 1;
    } else {
      this.min = Math.max(1, config.min ?? DEFAULT_MIN);
      this.max = Math.max(this.min, config.max ?? DEFAULT_MAX);
    }

    this.idleTimeout = Math.max(0, config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT);
    this.acquireTimeout = Math.max(1, config.acquireTimeout ?? DEFAULT_ACQUIRE_TIMEOUT);
    this.busyTimeout = Math.max(0, config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT);
    this.onOpen = config.onOpen;

    if (!isMemory) {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    }
  }

  /** Warm a connection without borrowing it (used at startup). */
  warm(): void {
    if (!this.primary) {
      this.primary = this.openConnection();
    }
  }

  /**
   * The long-lived "primary" connection used by the legacy read APIs and for
   * anything that needs a stable handle. It is never busy-marked and stays
   * open for the process lifetime (closed only on drain).
   */
  primaryDb(): Database {
    if (!this.primary || !this.primary.db.open) {
      this.primary = this.openConnection();
    }
    this.primary.lastUsedAt = Date.now();
    return this.primary.db;
  }

  /**
   * Borrow a connection for the duration of one (or a few, adjacent)
   * synchronous statement(s). Release it with {@link release}.
   */
  acquire(): Database {
    if (this.closed) {
      throw new SqlitePoolError(`Database pool is closed (${this.filename})`);
    }
    const now = Date.now();
    this.evictIdle(now);

    let candidate = this.pickIdle();

    if (!candidate && this.connections.length < this.max) {
      candidate = this.openConnection();
      this.connections.push(candidate);
    }

    if (!candidate && this.connections.length > 0) {
      // Saturated: a synchronous operation can only hold a connection for the
      // duration of a single stack frame, so waiting a moment to re-check is
      // sufficient in practice; fall back to reusing the oldest handle.
      const deadline = now + this.acquireTimeout;
      while (Date.now() < deadline) {
        candidate = this.pickIdle();
        if (candidate) {
          break;
        }
        if (this.connections.length < this.max) {
          candidate = this.openConnection();
          this.connections.push(candidate);
          break;
        }
        if (this.connections.length > 0) {
          candidate = this.connections.reduce((a, b) =>
            a.lastUsedAt <= b.lastUsedAt ? a : b,
          );
          break;
        }
        idleSleep(5);
      }
    }

    if (!candidate) {
      throw new SqlitePoolError(
        `Database pool exhausted for ${this.filename}` +
          ` (${this.status().total} open, ${this.status().busy} busy)`,
      );
    }

    candidate.busy = true;
    candidate.lastUsedAt = Date.now();
    return candidate.db;
  }

  /** Return a connection previously obtained from {@link acquire}. */
  release(database: Database): void {
    const conn = this.connections.find((c) => c.db === database);
    if (!conn) {
      throw new SqlitePoolError("Cannot release a connection this pool does not own");
    }
    conn.busy = false;
    conn.lastUsedAt = Date.now();
  }

  /**
   * Borrow a connection for a synchronous function and release it afterwards,
   * propagating the return value. This is the safe, recommended API.
   */
  withConnection<T>(fn: (database: Database) => T): T {
    const database = this.acquire();
    try {
      return fn(database);
    } finally {
      this.release(database);
    }
  }

  /** Snapshot of pool health for health checks and Prometheus metrics (#735). */
  status(): SqlitePoolStatus {
    const open = this.connections.filter((c) => c.db.open);
    return {
      filename: this.filename,
      min: this.min,
      max: this.max,
      idleTimeout: this.idleTimeout,
      acquireTimeout: this.acquireTimeout,
      busyTimeout: this.busyTimeout,
      total: open.length,
      idle: open.filter((c) => !c.busy).length,
      busy: open.filter((c) => c.busy).length,
      closed: this.closed,
    };
  }

  /** Close every connection, including the primary handle. Idempotent. */
  drain(): void {
    this.closed = true;
    for (const conn of [this.primary, ...this.connections]) {
      if (conn && conn.db.open) {
        try {
          conn.db.close();
        } catch {
          // already closed by an external caller — ignore
        }
      }
    }
    this.primary = null;
    this.connections = [];
  }

  private openConnection(): ManagedConnection {
    const database = new Database(this.filename);
    database.pragma(`busy_timeout = ${this.busyTimeout}`);
    database.pragma("journal_mode = WAL");
    this.onOpen?.(database);
    return { db: database, busy: false, lastUsedAt: Date.now() };
  }

  private pickIdle(): ManagedConnection | undefined {
    return this.connections
      .filter((c) => c.db.open && !c.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
  }

  private evictIdle(now: number): void {
    if (this.idleTimeout <= 0) {
      return;
    }
    for (let i = this.connections.length - 1; i >= 0; i--) {
      const conn = this.connections[i]!;
      if (!conn.db.open || conn.busy) {
        continue;
      }
      const idleLongEnough = now - conn.lastUsedAt >= this.idleTimeout;
      const overMin = this.connections.length > this.min;
      const overMax = this.connections.length > this.max;
      if (overMax || (idleLongEnough && overMin)) {
        conn.db.close();
        this.connections.splice(i, 1);
      }
    }
  }
}
