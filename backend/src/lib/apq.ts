import crypto from "node:crypto";

export type PersistedQueryExtension = {
  version?: number;
  sha256Hash?: string;
};

export type GraphQLRequest = {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  extensions?: {
    persistedQuery?: PersistedQueryExtension;
  };
};

export class PersistedQueryError extends Error {
  constructor(public readonly code: "PERSISTED_QUERY_NOT_FOUND" | "PERSISTED_QUERY_NOT_SUPPORTED" | "PERSISTED_QUERY_HASH_MISMATCH") {
    super(code === "PERSISTED_QUERY_NOT_FOUND" ? "PersistedQueryNotFound" : code);
    this.name = "PersistedQueryError";
  }
}

type CacheEntry = { query: string; expiresAt: number };

/**
 * Apollo automatic persisted queries use SHA-256 query hashes. The cache is
 * bounded and expiring so an attacker cannot grow it without limit.
 */
export class PersistedQueryCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly maxEntries = 1_000,
    private readonly now = () => Date.now(),
  ) {}

  resolve(request: GraphQLRequest): string {
    const persisted = request.extensions?.persistedQuery;
    if (!persisted) {
      if (!request.query) throw new Error("GraphQL query is required");
      return request.query;
    }
    if (persisted.version !== 1) {
      throw new PersistedQueryError("PERSISTED_QUERY_NOT_SUPPORTED");
    }
    if (!/^[a-f0-9]{64}$/i.test(persisted.sha256Hash ?? "")) {
      throw new PersistedQueryError("PERSISTED_QUERY_HASH_MISMATCH");
    }

    const hash = persisted.sha256Hash!.toLowerCase();
    this.evictExpired();
    if (request.query) {
      const actualHash = crypto.createHash("sha256").update(request.query).digest("hex");
      if (actualHash !== hash) {
        throw new PersistedQueryError("PERSISTED_QUERY_HASH_MISMATCH");
      }
      this.entries.delete(hash);
      this.entries.set(hash, { query: request.query, expiresAt: this.now() + this.ttlMs });
      this.enforceLimit();
      return request.query;
    }

    const entry = this.entries.get(hash);
    if (!entry) throw new PersistedQueryError("PERSISTED_QUERY_NOT_FOUND");
    entry.expiresAt = this.now() + this.ttlMs;
    return entry.query;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(hash);
    }
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}
