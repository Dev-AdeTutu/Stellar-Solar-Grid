/**
 * SMS notification endpoints (#997).
 *
 *   GET  /api/users/sms-preferences?phone=     — opted-in events for a phone
 *   POST /api/users/sms-preferences             — { phone, preferences: { low_balance?, payment_received?, meter_issue? } }
 *
 * Admin (X-Admin-Key):
 *   POST /api/sms-notifications/send            — { phone, event, message } — respects opt-in and the daily rate limit
 */
import { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  getSmsPreferences, isValidPhone, sendSmsNotification, setSmsPreferences, SMS_EVENTS,
} from "../lib/smsNotifications.js";

export const smsPreferencesRouter = Router();
export const smsNotificationsRouter = Router();

smsPreferencesRouter.get("/sms-preferences", (req, res) => {
  const phone = typeof req.query.phone === "string" ? req.query.phone : "";
  if (!isValidPhone(phone)) return res.status(400).json({ error: "phone must be a valid E.164 number, e.g. +2348012345678" });
  res.json({ phone, preferences: getSmsPreferences(phone) });
});

const preferencesSchema = z.object({
  phone: z.string(),
  preferences: z.object(Object.fromEntries(SMS_EVENTS.map((e) => [e, z.boolean().optional()]))).partial(),
});

smsPreferencesRouter.post("/sms-preferences", (req, res) => {
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Expected { phone, preferences: { low_balance?, payment_received?, meter_issue? } }" });
  if (!isValidPhone(parsed.data.phone)) return res.status(400).json({ error: "phone must be a valid E.164 number, e.g. +2348012345678" });
  res.json({ phone: parsed.data.phone, preferences: setSmsPreferences(parsed.data.phone, parsed.data.preferences) });
});

const sendSchema = z.object({
  phone: z.string(),
  event: z.enum(SMS_EVENTS),
  message: z.string().min(1).max(320),
});

smsNotificationsRouter.post(
  "/send",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Expected { phone, event, message }" });
    if (!isValidPhone(parsed.data.phone)) return res.status(400).json({ error: "phone must be a valid E.164 number, e.g. +2348012345678" });
    const outcome = await sendSmsNotification(parsed.data);
    if (!outcome.ok) {
      const status = outcome.reason === "rate-limited" ? 429 : 202;
      return res.status(status).json({ accepted: false, reason: outcome.reason });
    }
    res.status(outcome.result.delivered ? 200 : 202).json({ accepted: true, delivered: outcome.result.delivered, provider: outcome.result.provider });
  }),
);
