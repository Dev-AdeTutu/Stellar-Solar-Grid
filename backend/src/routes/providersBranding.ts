import { Router, Request, Response } from "express";
import { getProviderBranding } from "../lib/providerBranding.js";
import { getBrandingDb } from "../lib/providerBranding.js";
import fs from "fs";
import path from "path";

export const providersBrandingRouter = Router();

providersBrandingRouter.post("/:id/branding", (req: Request, res: Response) => {
  try {
    const providerId = req.params.id;
    const saved = upsertProviderBranding(providerId, {
      brandName: req.body?.brandName,
      logoUrl: req.body?.logoUrl,
      primaryColor: req.body?.primaryColor,
      secondaryColor: req.body?.secondaryColor,
      accentColor: req.body?.accentColor,
      customDomain: req.body?.customDomain,
      supportEmail: req.body?.supportEmail,
      footerText: req.body?.footerText,
      mobileAppBundleId: req.body?.mobileAppBundleId,
    });
    res.status(200).json(saved);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Invalid branding configuration" });
  }
});

providersBrandingRouter.get("/:id/branding", (req: Request, res: Response) => {
  const branding = getProviderBranding(req.params.id);
  if (!branding) {
    res.status(404).json({ error: "Provider branding not found" });
    return;
  }
  res.json(branding);
});

providersBrandingRouter.get("/by-domain/:domain", (req: Request, res: Response) => {
  const branding = getProviderBrandingByDomain(req.params.domain);
  if (!branding) {
    res.status(404).json({ error: "No provider branding configured for domain" });
    return;
  }
  res.json(branding);
});

providersBrandingRouter.get("/:id/branding/mobile-config", (req: Request, res: Response) => {
  const branding = getProviderBranding(req.params.id);
  if (!branding) {
    res.status(404).json({ error: "Provider branding not found" });
    return;
  }
  res.json(generateWhiteLabelMobileConfig(branding));
});

providersBrandingRouter.post("/:id/branding/email-preview", (req: Request, res: Response) => {
  const branding = getProviderBranding(req.params.id);
  if (!branding) {
    res.status(404).json({ error: "Provider branding not found" });
    return;
  }
  const subject = req.body?.subject || "Solar Grid Notification";
  const bodyHtml = req.body?.bodyHtml || "<p>Your meter balance has been updated.</p>";
  const html = renderBrandedEmailTemplate(branding, subject, bodyHtml);
  res.json({ subject, html });
});

// New route to serve logo files with correct Content-Type
providersBrandingRouter.get("/:id/logo", (req: Request, res: Response) => {
  const providerId = req.params.id;
  const db = getBrandingDb();
  const branding = db.prepare("SELECT logo_url FROM provider_branding WHERE provider_id = ?").get(providerId);
  if (!branding) {
    return res.status(404).json({ error: "Logo not found" });
  }
  const relativePath = branding.logo_url?.replace(/^\/+/, ""); // strip leading slash
  if (!relativePath) {
    return res.status(404).json({ error: "No logo URL configured" });
  }
  const absolutePath = path.resolve(process.cwd(), "public", relativePath);
  try {
    const data = fs.readFileSync(absolutePath);
    const ext = path.extname(relativePath).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".svg") contentType = "image/svg+xml";
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.send(data);
  } catch (e) {
    console.error("Error serving logo:", e);
    res.status(404).json({ error: "Logo file not found" });
  }
});
