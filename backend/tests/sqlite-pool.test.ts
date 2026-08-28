import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqlitePool } from "../src/lib/sqlitePool.js";

function tempDb(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "pool.sqlite");
}

describe("createSqlitePool (Issue #735)", () => {
  it("in-memory pools use a single shared connection", () => {
    const pool = createSqlitePool({
      filename: ":memory:",
      onCreate(db) {
        db.exec("CREATE TABLE t (v TEXT)");
      },
    });

    expect(pool.getStats().singleConnectionMode).toBe(true);

    const a = pool.acquire();
    a.exec("INSERT INTO t (v) VALUES ('shared')");
    const b = pool.acquire();
    expect(b.prepare("SELECT v FROM t").get()).toEqual({ v: "shared" });

    pool.release(a);
    pool.release(b);
  });

  it("warms up min connections and reuses handles instead of always opening", () => {
    const pool = createSqlitePool({
      filename: tempDb("sqlite-pool-reuse-"),
      min: 1,
      max: 5,
      acquireTimeoutMs: 200,
    });

    expect(pool.getStats().size).toBe(1); // min warm-up
    expect(pool.getStats().min).toBe(1);

    const c1 = pool.acquire();
    const c2 = pool.acquire();
    const c3 = pool.acquire();

    // Each concurrent acquisition grew the pool up to max.
    expect(pool.getStats().size).toBe(4);
    expect(pool.getStats().active).toBe(3);

    // Releasing makes a handle acquirable again without opening a new one.
    pool.release(c2);
    const c2again = pool.acquire();
    expect(pool.getStats().size).toBe(4);

    pool.release(c1);
    pool.release(c3);
    pool.release(c2again);
    pool.drain();
    expect(pool.getStats().size).toBe(0);
  });

  it("throws a clear error when the pool is exhausted past acquireTimeoutMs", () => {
    const pool = createSqlitePool({
      filename: tempDb("sqlite-pool-exhaust-"),
      min: 1,
      max: 3, // primary + 2 rotating connections
      acquireTimeoutMs: 50,
    });

    const a = pool.acquire();
    const b = pool.acquire();
    expect(() => pool.acquire()).toThrow(/exhausted/);

    pool.release(a);
    pool.release(b);
    pool.drain();
  });

  it("drain closes every pooled connection, including the primary handle", () => {
    const pool = createSqlitePool({
      filename: tempDb("sqlite-pool-drain-"),
      min: 2,
      max: 2,
    });

    const primary = pool.primary();
    const extra = pool.acquire();
    expect(primary.open).toBe(true);
    expect(extra.open).toBe(true);

    pool.drain();
    expect(primary.open).toBe(false);
    expect(extra.open).toBe(false);
  });

  it("keeps the primary handle stable and excluded from rotation", () => {
    const pool = createSqlitePool({
      filename: tempDb("sqlite-pool-primary-"),
      min: 1,
      max: 4,
    });

    const primary = pool.primary();
    const rotated = pool.acquire();
    expect(rotated).not.toBe(primary);
    pool.release(rotated);

    pool.drain();
  });

  it("is usable for real work (create/insert/read) without a pre-set onCreate", () => {
    const filename = tempDb("sqlite-pool-work-");
    const pool = createSqlitePool({ filename, min: 1, max: 2 });

    const conn = pool.acquire();
    conn.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    conn.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
    expect(conn.prepare("SELECT v FROM t").get()).toEqual({ v: "hello" });
    pool.release(conn);

    pool.drain();
  });
});