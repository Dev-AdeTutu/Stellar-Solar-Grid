import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger.js";
import { hasTwoFactor, setupTwoFactor, verifyTwoFactor } from "../lib/twoFactor.js";

export const adminLoginRouter = Router();
const adminId = () => process.env.ADMIN_ID ?? "default-admin";
function jwtSecret(): string { return process.env.JWT_SECRET ?? process.env.ADMIN_API_KEY ?? ""; }

adminLoginRouter.post("/login", (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_API_KEY;
  if (!adminSecret) {
    logger.error("ADMIN_API_KEY env var not set");
    return res.status(503).json({ error: "Server misconfiguration", code: "SERVER_MISCONFIGURATION" });
  }
  const { secret, code } = req.body as { secret?: string; code?: string };
  if (!secret || secret !== adminSecret) return res.status(401).json({ error: "Invalid admin secret", code: "UNAUTHORIZED" });
  if (hasTwoFactor(adminId()) && (!code || !verifyTwoFactor(adminId(), code))) {
    return res.status(401).json({ error: "A valid authenticator code or recovery code is required", code: "MFA_REQUIRED", mfaRequired: true });
  }
  return res.json({ token: jwt.sign({ role: "admin", mfa: hasTwoFactor(adminId()) }, jwtSecret(), { expiresIn: "8h" }) });
});

adminLoginRouter.post("/2fa/setup", (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_API_KEY;
  if (!adminSecret || req.body?.secret !== adminSecret) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  if (hasTwoFactor(adminId())) return res.status(409).json({ error: "2FA is already configured", code: "ALREADY_CONFIGURED" });
  try {
    const result = setupTwoFactor(adminId());
    return res.status(201).json({ ...result, otpauthUrl: `otpauth://totp/Stellar%20Solar%20Grid:${encodeURIComponent(adminId())}?secret=${result.secret}&issuer=Stellar%20Solar%20Grid` });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : "2FA unavailable", code: "MFA_MISCONFIGURED" });
  }
});

adminLoginRouter.post("/2fa/verify", (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };
  if (!code || !verifyTwoFactor(adminId(), code)) return res.status(401).json({ error: "Invalid authenticator or recovery code", code: "INVALID_MFA" });
  return res.json({ verified: true });
});
