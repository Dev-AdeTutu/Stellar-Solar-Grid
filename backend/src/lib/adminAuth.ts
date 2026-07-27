import type { Request, Response, NextFunction } from "express";

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_PUBLIC_KEY;
  if (!expected) {
    return res.status(500).json({ error: "ADMIN_PUBLIC_KEY is not configured" });
  }

  const provided = req.header("x-admin-key");
  if (provided !== expected) {
    return res.status(401).json({ error: "admin key required" });
  }

  return next();
}
