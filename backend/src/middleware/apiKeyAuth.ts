/**
 * API key middleware (#833): validates the `X-API-Key` header and attaches the
 * key record to `res.locals.apiKey`. Optionally require a permission.
 */
import type { NextFunction, Request, Response } from "express";
import { validateApiKey, type ApiKeyPermission } from "../lib/apiKeys.js";

export function requireApiKey(permission?: ApiKeyPermission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("X-API-Key");
    if (!header) {
      return res.status(401).json({ error: "Missing X-API-Key header" });
    }
    const record = validateApiKey(header);
    if (!record) {
      return res.status(401).json({ error: "Invalid, expired or revoked API key" });
    }
    if (
      permission &&
      !record.permissions.includes(permission) &&
      !record.permissions.includes("admin")
    ) {
      return res.status(403).json({ error: `API key lacks '${permission}' permission` });
    }
    res.locals.apiKey = record;
    next();
  };
}
