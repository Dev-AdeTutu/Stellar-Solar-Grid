import { Request, Response, NextFunction } from "express";

/** How long a non-2xx response is cached, so a recovered upstream is not hidden behind an old error. */
export const ERROR_CACHE_TTL_MS = 10_000;

type Entry = { data: unknown; status: number; expiresAt: number };
const store = new Map<string, Entry>();

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * Caches a route's JSON responses by URL for `ttlMs`.
 *
 * Only 2xx responses get the full TTL. Any other status (a 503 from an upstream, a 404, a 500) is
 * cached for `ERROR_CACHE_TTL_MS` at most (or `ttlMs` if that is shorter), and is replayed with its
 * original status and `Cache-Control: no-store`, so clients and CDNs do not keep it.
 */
export function cacheFor(ttlMs: number, errorTtlMs = ERROR_CACHE_TTL_MS) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.originalUrl;
    const cached = store.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      if (isSuccess(cached.status)) {
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
      } else {
        res.setHeader('Cache-Control', 'no-store');
        res.status(cached.status);
      }
      return res.json(cached.data);
    }
    const original = res.json.bind(res);
    res.json = (data: unknown) => {
      const status = res.statusCode;
      const ok = isSuccess(status);
      if (store.size > 500) store.clear(); // bound memory
      store.set(key, { data, status, expiresAt: Date.now() + (ok ? ttlMs : Math.min(ttlMs, errorTtlMs)) });
      res.setHeader('Cache-Control', ok ? `public, max-age=${Math.floor(ttlMs / 1000)}` : 'no-store');
      return original(data);
    };
    next();
  };
}

export function invalidateCache(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Empties the cache. For tests. */
export function _resetCacheForTests(): void {
  store.clear();
}

import crypto from "crypto";

export function etagFor(data: unknown): string {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  const hash = crypto.createHash("sha1").update(str).digest("base64");
  return `W/"${hash}"`;
}

