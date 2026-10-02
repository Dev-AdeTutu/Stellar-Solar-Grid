import express, { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  EMAIL_EVENTS,
  getEmailPreferences,
  setEmailPreference,
  unsubscribeEmail,
  verifyEmailPreferenceToken,
} from "../lib/emailNotifications.js";
import { emailPriceAlert } from "../lib/billing.js";

export const emailNotificationsRouter = Router();
emailNotificationsRouter.use(express.urlencoded({ extended: false }));

emailNotificationsRouter.get("/preferences", (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const email = verifyEmailPreferenceToken(token);
  if (!email) return res.status(400).json({ error: "Invalid or expired preference token" });
  res.json({ preferences: getEmailPreferences(email) });
});

emailNotificationsRouter.get("/manage", (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const email = verifyEmailPreferenceToken(token);
  if (!email) return res.status(400).send("Invalid or expired preference token");
  const events = EMAIL_EVENTS.map((event) => `<label style="display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #ddd"><input type="checkbox" name="${event}"><span>${event.replaceAll("_", " ")}</span></label>`).join("");
  const safeToken = JSON.stringify(token);
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head><body style="margin:0;padding:24px;font:16px system-ui;color:#202a25;background:#f3f6f3"><main style="max-width:520px;margin:8vh auto;background:white;padding:24px;border:1px solid #d7dfd9;border-radius:6px"><h1 style="font-size:24px;margin-top:0">Email preferences</h1><p>Choose the SolarGrid updates you want to receive.</p><form id="preferences">${events}<button style="margin-top:20px;padding:10px 16px" type="submit">Save preferences</button></form><p id="status" role="status"></p></main><script>const token=${safeToken};const form=document.querySelector('#preferences');const status=document.querySelector('#status');fetch('/api/email-notifications/preferences?token='+encodeURIComponent(token)).then(r=>r.json()).then(({preferences})=>{for(const [event,enabled] of Object.entries(preferences)){form.elements[event].checked=enabled}});form.addEventListener('submit',async event=>{event.preventDefault();for(const input of form.querySelectorAll('input')){const response=await fetch('/api/email-notifications/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,event:input.name,enabled:input.checked})});if(!response.ok){status.textContent='Unable to save preferences.';return}}status.textContent='Preferences saved.'});</script></body></html>`);
});

emailNotificationsRouter.put("/preferences", (req, res) => {
  const parsed = z.object({ token: z.string().min(1), event: z.enum(EMAIL_EVENTS), enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid preference update" });
  const email = verifyEmailPreferenceToken(parsed.data.token);
  if (!email) return res.status(400).json({ error: "Invalid or expired preference token" });
  setEmailPreference(email, parsed.data.event, parsed.data.enabled);
  res.json({ preferences: getEmailPreferences(email) });
});

emailNotificationsRouter.get("/unsubscribe", (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const email = verifyEmailPreferenceToken(token);
  if (!email) return res.status(400).json({ error: "Invalid or expired unsubscribe token" });
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="margin:0;padding:24px;font:16px system-ui;color:#202a25;background:#f3f6f3"><main style="max-width:520px;margin:8vh auto;background:white;padding:24px;border:1px solid #d7dfd9;border-radius:6px"><h1 style="font-size:24px;margin-top:0">Unsubscribe from SolarGrid email</h1><p>Confirm to stop all non-essential SolarGrid email notifications for ${email.replace(/[&<>"']/g, "") }.</p><form method="post" action="/api/email-notifications/unsubscribe"><input type="hidden" name="token" value="${token}"><button style="padding:10px 16px" type="submit">Unsubscribe</button></form></main></body></html>`);
});

emailNotificationsRouter.post("/unsubscribe", (req, res) => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid unsubscribe token" });
  const email = verifyEmailPreferenceToken(parsed.data.token);
  if (!email) return res.status(400).json({ error: "Invalid or expired unsubscribe token" });
  unsubscribeEmail(email);
  res.json({ unsubscribed: true });
});

emailNotificationsRouter.post("/price-alert", requireAdminKey, async (req, res) => {
  const parsed = z.object({
    email: z.string().email().max(254),
    title: z.string().min(1).max(160),
    message: z.string().min(1).max(4_000),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid price alert notification" });
  try {
    const delivered = await emailPriceAlert(parsed.data);
    res.status(delivered ? 200 : 202).json({ accepted: true, delivered });
  } catch {
    res.status(502).json({ error: "Email provider could not deliver the price alert" });
  }
});