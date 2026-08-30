import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { SqlitePool, SqlitePoolError } from "../src/lib/sqlitePool";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-pool-"));
  return path.join(dir, "test.sqlite");
}

function makePool(
  overrides: Partial<Parameters<typeof SqlitePool.prototype.constructor>[0]> = {},
) {
  const filename = overrides.filename ?? tmpDbPath();
  return new SqlitePool({
    filename,
    min: 1,
    max: 3,
    idleTimeout: 300,
    acquireTimeout: 1000,
    ...overrides,
  });
}

describe("SqlitePool (#735)", () => {
  it("runs synchronous work through withConnection and reflects it in status", () => {
    const pool = makePool();
    const result = pool.withConnection((connection) => {
      connection.exec("CREATE TABLE t (x INTEGER)");
      connection.prepare("INSERT INTO t (x) VALUES (?)").run(42);
      const status = pool.status();
      expect(status.total).toBe(1);
      expect(status.idle).toBe(0);
      expect(status.busy).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(pool.status().idle).toBe(1);
    pool.drain();
  });

  it("reuses the warm connection instead of opening a new one per operation", () => {
    const pool = makePool();
    for (let i = 0; i < 5; i++) {
      pool.withConnection((connection) => {
        connection.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      });
    }
    expect(pool.status().total).toBe(1);
    pool.drain();
  });

  it("respects the max bound and never opens more than max connections", () => {
    const pool = makePool({ min: 1, max: 3 });
    const held: Array<ReturnType<typeof pool.acquire>> = [];
    held.push(pool.acquire());
    held.push(pool.acquire());
    held.push(pool.acquire());

    expect(pool.status().total).toBe(3);
    expect(pool.status().busy).toBe(3);

    // Saturated: synchronous fallback reuses the least-recently-used handle.
    const extra = pool.acquire();
    expect(pool.status().total).toBeLessThanOrEqual(3);

    for (const connection of held) {
      pool.release(connection);
    }
    pool.release(extra);
    expect(pool.status().idle).toBe(3);
    pool.drain();
  });

  it("evicts idle connections down to min after the idle timeout", async () => {
    const pool = makePool({ min: 1, max: 3, idleTimeout: 150 });
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(pool.status().total).toBe(3);

    pool.release(a);
    pool.release(b);
    expect(pool.status().idle).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 250));

    // Next acquire triggers lazy eviction of the two stale idle connections.
    pool.acquire();
    const status = pool.status();
    expect(status.total).toBeLessThan(3);
    expect(status.total).toBeGreaterThanOrEqual(pool.min);
    pool.drain();
  });

  it("primaryDb and pooled connections share the same database file", () => {
    const pool = makePool();
    pool.primaryDb().exec("CREATE TABLE t (x INTEGER)");
    pool.withConnection((connection) => {
      connection.prepare("INSERT INTO t (x) VALUES (?)").run(1);
    });
    const { c } = pool
      .primaryDb()
      .prepare("SELECT COUNT(*) as c FROM t")
      .get() as { c: number };
    expect(c).toBe(1);
    pool.drain();
  });

  it("drain closes every connection including the primary handle", () => {
    const pool = makePool();
    const primary = pool.primaryDb();
    pool.withConnection((connection) =>
      connection.exec("CREATE TABLE t (x INTEGER)"),
    );
    expect(primary.open).toBe(true);

    pool.drain();

    expect(primary.open).toBe(false);
    expect(pool.status().closed).toBe(true);
    expect(() => pool.acquire()).toThrow(SqlitePoolError);
  });

  it("restricts :memory: pools to a single connection", () => {
    const pool = new SqlitePool({ filename: ":memory:", min: 2, max: 10 });
    for (let i = 0; i < 3; i++) {
      pool.withConnection((connection) => {
        connection.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      });
    }
    expect(pool.status().total).toBe(1);
    expect(pool.min).toBe(1);
    expect(pool.max).toBe(1);
    pool.drain();
  });
});
