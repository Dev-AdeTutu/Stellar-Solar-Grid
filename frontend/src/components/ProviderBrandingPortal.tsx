"use client";

import React, { useState } from "react";
import { applyDynamicBrandingTheme, BrandingConfig, branding } from "../lib/branding";

export const ProviderBrandingPortal: React.FC<{ defaultProviderId?: string }> = ({
  defaultProviderId = "provider-1",
}) => {
  const [providerId, setProviderId] = useState(defaultProviderId);
  const [form, setForm] = useState<BrandingConfig>({
    name: branding.name || "SolarGrid Partner",
    logoUrl: branding.logoUrl || "https://example.com/logo.svg",
    primaryColor: branding.primaryColor || "#f59e0b",
    secondaryColor: branding.secondaryColor || "#0ea5e9",
    accentColor: "#10b981",
    customDomain: "energy.partner.example.com",
    footerText: branding.footerText || "Powered by Stellar Solar Grid",
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    applyDynamicBrandingTheme(form);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/branding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandName: form.name,
          logoUrl: form.logoUrl,
          primaryColor: form.primaryColor,
          secondaryColor: form.secondaryColor,
          accentColor: form.accentColor,
          customDomain: form.customDomain,
          footerText: form.footerText,
        }),
      });
      if (res.ok) {
        setStatusMessage("Branding saved and applied dynamically.");
      } else {
        setStatusMessage("Theme applied locally.");
      }
    } catch {
      setStatusMessage("Theme applied locally.");
    }
  };

  return (
    <div className="p-6 bg-slate-900 text-white rounded-xl border border-slate-800 space-y-6">
      <div>
        <h2 className="text-xl font-bold">White-Label Provider Customization</h2>
        <p className="text-sm text-slate-400">
          Customize logo, brand colors, custom domain, email templates, and mobile app bundle config.
        </p>
      </div>

      <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block text-sm space-y-1">
          <span className="text-slate-300">Provider ID</span>
          <input
            type="text"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2"
          />
        </label>

        <label className="block text-sm space-y-1">
          <span className="text-slate-300">Brand Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2"
          />
        </label>

        <label className="block text-sm space-y-1">
          <span className="text-slate-300">Logo URL</span>
          <input
            type="url"
            value={form.logoUrl || ""}
            onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2"
          />
        </label>

        <label className="block text-sm space-y-1">
          <span className="text-slate-300">Custom Domain</span>
          <input
            type="text"
            value={form.customDomain || ""}
            onChange={(e) => setForm({ ...form, customDomain: e.target.value })}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2"
          />
        </label>

        <label className="block text-sm space-y-1">
          <span className="text-slate-300">Primary Color</span>
          <input
            type="text"
            value={form.primaryColor}
            onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2"
          />
        </label>

        <label className="block text-sm space-y-1">
          <span className="text-slate-300">Secondary Color</span>
          <input
            type="text"
            value={form.secondaryColor}
            onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2"
          />
        </label>

        <div className="md:col-span-2 flex items-center gap-4 pt-2">
          <button
            type="submit"
            className="px-4 py-2 rounded font-semibold text-slate-950"
            style={{ backgroundColor: form.primaryColor }}
          >
            Save &amp; Apply Branding
          </button>
          {statusMessage && <span className="text-sm text-emerald-400">{statusMessage}</span>}
        </div>
      </form>
    </div>
  );
};

export default ProviderBrandingPortal;
