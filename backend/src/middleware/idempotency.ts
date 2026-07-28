/**
 * Idempotency-Key middleware
 *
 * Caches { statusCode, body } keyed by SHA-256(Idempotency-Key + route path)
 * for 24 hours. A repeated key within that window returns the cached response
 * without re-invoking the handler — preventing duplicate on-chain calls.
 *
 * Concurrent requests with the same key (in-flight dedup) are rejected with
 * 409 Conflict so only one call reaches the contract at a time.
 *
 * Usage:
 *   router.post("/", idempotency(), asyncHandler(async (req, res) => { ... }));
 *
 * The middleware is route-scoped so the same key on different endpoints never
 * collide (the route path is mixed into the cache key hash).
 */

import { createHash } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 10_000;           // memory safety ceiling

interface CacheEntry {
  status: number;
  body: unknown;
  expiresAt: number;
}

// Single shared store for all idempotency entries across all routes.
// Keyed by SHA-256(idempotencyKey + routePath) so different endpoints
// using the same client-supplied key cannot collide.
const store = new Map<string, CacheEntry>();

// Tracks keys whose first request is still in-flight.
const inFlight = new Set<string>();

/** Derive a stable, opaque store key from the raw Idempotency-Key + route. */
function storeKey(idempotencyKey: string, routePath: string): string {
  return createHash("sha256")
    .update(idempotencyKey)
    .update("|")
    .update(routePath)
    .digest("hex");
}

/** Evict expired entries. Called before every write to keep memory bounded. */
function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now >= v.expiresAt) store.delete(k);
  }
  // Hard ceiling: if still over limit after eviction, clear oldest half.
  if (store.size >= MAX_ENTRIES) {
    const keys = [...store.keys()];
    keys.slice(0, Math.floor(MAX_ENTRIES / 2)).forEach((k) => store.delete(k));
  }
}

/**
 * Express middleware factory.
 *
 * When mounted on a route, the route path used in the cache key is derived
 * from `req.baseUrl + req.path` so it is always route-specific even when
 * the middleware is reused across multiple routers.
 */
export function idempotency(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers["idempotency-key"];

    // Header absent or empty — pass through; no idempotency guarantee.
    if (!raw || typeof raw !== "string" || raw.trim() === "") {
      next();
      return;
    }

    const key = raw.trim();
    // Include the resolved path so the same key on /api/payments and
    // /api/collaborators never maps to the same cache entry.
    const routePath = req.baseUrl + req.path;
    const sk = storeKey(key, routePath);

    // ── Replay cached response ─────────────────────────────────────────────
    const cached = store.get(sk);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        res.setHeader("X-Idempotent-Replayed", "true");
        res.status(cached.status).json(cached.body);
        return;
      }
      store.delete(sk); // expired — fall through to fresh execution
    }

    // ── Concurrent duplicate guard ─────────────────────────────────────────
    if (inFlight.has(sk)) {
      res.status(409).json({
        error: "A request with this Idempotency-Key is already being processed",
        code: "IDEMPOTENCY_CONFLICT",
      });
      return;
    }

    // ── First request — intercept the response and cache it ───────────────
    inFlight.add(sk);

    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      inFlight.delete(sk);

      // Only cache success and client-error responses (not 5xx).
      // A 5xx should be retried and should re-hit the contract.
      if (res.statusCode < 500) {
        evictExpired();
        store.set(sk, {
          status: res.statusCode,
          body,
          expiresAt: Date.now() + TTL_MS,
        });
      }

      return originalJson(body);
    };

    // Make sure inFlight is cleared even if the handler throws and never
    // calls res.json (e.g. passes to error middleware).
    res.on("finish", () => {
      inFlight.delete(sk);
    });

    next();
  };
}

/** Exported for testing only — lets tests inspect or clear the store. */
export const _idempotencyStore = store;
export const _idempotencyInFlight = inFlight;
