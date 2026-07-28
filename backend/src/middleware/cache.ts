import { Request, Response, NextFunction } from "express";

const store = new Map<string, { data: unknown; expiresAt: number }>();

export function cacheFor(ttlMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.originalUrl;
    const cached = store.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
      return res.json(cached.data);
    }
    const original = res.json.bind(res);
    res.json = (data: unknown) => {
      if (store.size > 500) store.clear(); // bound memory
      store.set(key, { data, expiresAt: Date.now() + ttlMs });
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
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

import crypto from "crypto";

export function etagFor(data: unknown): string {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  const hash = crypto.createHash("sha1").update(str).digest("base64");
  return `W/"${hash}"`;
}

