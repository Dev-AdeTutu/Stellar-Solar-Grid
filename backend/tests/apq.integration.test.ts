import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { PersistedQueryCache, PersistedQueryError } from "../src/lib/apq.js";

function hash(query: string): string {
  return crypto.createHash("sha256").update(query).digest("hex");
}

describe("automatic persisted queries (#771)", () => {
  it("registers a full query and resolves a hash-only request", () => {
    const cache = new PersistedQueryCache();
    const query = "query Health { health }";
    const extension = { persistedQuery: { version: 1, sha256Hash: hash(query) } };

    expect(cache.resolve({ query, extensions: extension })).toBe(query);
    expect(cache.resolve({ extensions: extension })).toBe(query);
  });

  it("returns the standard not-found error for an unknown hash", () => {
    const cache = new PersistedQueryCache();
    expect(() => cache.resolve({ extensions: { persistedQuery: { version: 1, sha256Hash: "a".repeat(64) } } }))
      .toThrowError(PersistedQueryError);
  });

  it("rejects mismatched hashes and unsupported protocol versions", () => {
    const cache = new PersistedQueryCache();
    expect(() => cache.resolve({
      query: "query Health { health }",
      extensions: { persistedQuery: { version: 1, sha256Hash: "b".repeat(64) } },
    })).toThrowError(/PERSISTED_QUERY_HASH_MISMATCH/);
    expect(() => cache.resolve({
      query: "query Health { health }",
      extensions: { persistedQuery: { version: 2, sha256Hash: hash("query Health { health }") } },
    })).toThrowError(/PERSISTED_QUERY_NOT_SUPPORTED/);
  });

  it("expires entries and evicts the oldest entry at the size limit", () => {
    let now = 0;
    const cache = new PersistedQueryCache(100, 2, () => now);
    const queries = ["query A { health }", "query B { health }", "query C { health }"];
    for (const query of queries.slice(0, 2)) {
      cache.resolve({ query, extensions: { persistedQuery: { version: 1, sha256Hash: hash(query) } } });
    }
    expect(cache.size).toBe(2);
    cache.resolve({ query: queries[2], extensions: { persistedQuery: { version: 1, sha256Hash: hash(queries[2]) } } });
    expect(cache.size).toBe(2);
    expect(() => cache.resolve({ extensions: { persistedQuery: { version: 1, sha256Hash: hash(queries[0]) } } })).toThrow();
    now = 101;
    expect(cache.size).toBe(0);
  });
});
