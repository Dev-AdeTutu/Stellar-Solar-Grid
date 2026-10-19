import { Router } from "express";
import { getSmsProviderConfig } from "../lib/smsProviders.js";

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
