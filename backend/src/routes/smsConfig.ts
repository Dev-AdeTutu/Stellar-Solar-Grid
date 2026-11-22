import { Router } from "express";
import { getSmsProviderConfig } from "../lib/smsProviders.js";
import { isValidSmsPhone, listSmsPhones, upsertSmsPhone } from "../lib/smsConfig.js";

export const smsConfigRouter = Router();

/**
 * GET /api/sms-config?region=<region>
 *
 * Returns the SMS shortcode (and any region-specific instructions) to show
 * in the offline-payment UI, sourced from backend/provider config instead of
 * a single build-time env var — lets different regions/telecom partners
 * display the correct shortcode without a frontend rebuild.
 */
smsConfigRouter.get("/", (req, res) => {
  const region = typeof req.query.region === "string" ? req.query.region : undefined;
  res.json(getSmsProviderConfig(region));
});

/**
 * GET /api/sms-config/phones
 * Lists the registered phone numbers. Each number appears at most once.
 */
smsConfigRouter.get("/phones", (_req, res) => {
  res.json({ phones: listSmsPhones() });
});

/**
 * POST /api/sms-config/phones
 *
 * Registers a phone number for SMS configuration. Re-posting an existing
 * number is an upsert, not a second row, so users never receive N copies of
 * every SMS (#1152).
 */
smsConfigRouter.post("/phones", (req, res) => {
  const phone = req.body?.phone;
  if (!isValidSmsPhone(phone)) {
    return res.status(400).json({ error: "phone must be a valid E.164 number, e.g. +2348012345678" });
  }
  const created = upsertSmsPhone(phone);
  return res.json({ phone, created, phones: listSmsPhones() });
});
