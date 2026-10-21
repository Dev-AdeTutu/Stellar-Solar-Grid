import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as tf from "../lib/twoFactor.js";
import { logger } from "../lib/logger.js";

export const twoFactorRouter = Router();

const account = z.string().min(1).max(128);

twoFactorRouter.post("/enroll", (req, res) => {
  const p = z.object({ account, phone: z.string().max(20).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  const out = tf.enroll(p.data.account, p.data.phone);
  res.status(201).json({ ...out, recoveryCodes: tf.generateRecoveryCodes(p.data.account) });
});

twoFactorRouter.post("/verify", (req, res) => {
  const p = z.object({ account, code: z.string().min(6).max(16), method: z.enum(["totp", "sms", "recovery"]).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  const ok = tf.verify(p.data.account, p.data.code, p.data.method);
  res.status(ok ? 200 : 401).json({ verified: ok });
});

twoFactorRouter.post("/sms", (req, res) => {
  const p = z.object({ account }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  const issued = tf.issueSmsCode(p.data.account);
  if (!issued) return res.status(404).json({ error: "No phone on file" });
  // Delivery is delegated to the configured SMS provider; never return the code.
  logger.info({ account: p.data.account }, "2FA SMS code issued");
  res.json({ sent: true });
});

twoFactorRouter.post("/recovery-codes", (req, res) => {
  const p = z.object({ account, code: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues });
  if (!tf.verify(p.data.account, p.data.code)) return res.status(401).json({ error: "Invalid code" });
  res.json({ recoveryCodes: tf.generateRecoveryCodes(p.data.account) });
});

/** Middleware enforcing 2FA for high-value accounts (value via X-Account-Value set upstream). */
export function requireTwoFactor(req: Request, res: Response, next: NextFunction) {
  const acct = String(req.headers["x-account"] ?? "");
  const value = Number(req.headers["x-account-value"] ?? 0);
  if (!tf.isTwoFactorRequired(value)) return next();
  const code = String(req.headers["x-2fa-code"] ?? "");
  if (tf.isEnabled(acct) && tf.verify(acct, code)) return next();
  res.status(403).json({ error: "Two-factor authentication required" });
}
