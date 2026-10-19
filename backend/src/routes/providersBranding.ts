import { Router, Request, Response } from "express";
import {
  generateWhiteLabelMobileConfig,
  getProviderBranding,
  getProviderBrandingByDomain,
  renderBrandedEmailTemplate,
  upsertProviderBranding,
} from "../lib/providerBranding.js";

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
