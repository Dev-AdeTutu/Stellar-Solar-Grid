import { env } from "@/lib/env";

export interface BrandingConfig {
  providerId?: string;
  name: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor?: string;
  customDomain?: string | null;
  footerText?: string;
}

export const branding: BrandingConfig = {
  name: env.NEXT_PUBLIC_BRAND_NAME,
  logoUrl: env.NEXT_PUBLIC_BRAND_LOGO_URL,
  primaryColor: env.NEXT_PUBLIC_BRAND_PRIMARY_COLOR,
  secondaryColor: env.NEXT_PUBLIC_BRAND_SECONDARY_COLOR,
  accentColor: "#10b981",
  footerText: env.NEXT_PUBLIC_BRAND_FOOTER_TEXT,
};

export function brandingCssVars(config: BrandingConfig = branding): Record<string, string> {
  return {
    "--color-brand-primary": config.primaryColor,
    "--color-brand-secondary": config.secondaryColor,
    "--color-brand-accent": config.accentColor ?? "#10b981",
  };
}

export function applyDynamicBrandingTheme(config: BrandingConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const vars = brandingCssVars(config);
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

export async function fetchProviderBranding(
  providerIdOrDomain: { providerId?: string; domain?: string }
): Promise<BrandingConfig> {
  const endpoint = providerIdOrDomain.domain
    ? `/api/providers/by-domain/${encodeURIComponent(providerIdOrDomain.domain)}`
    : `/api/providers/${encodeURIComponent(providerIdOrDomain.providerId || "default")}/branding`;

  const res = await fetch(endpoint);
  if (!res.ok) {
    return branding;
  }
  const data = await res.json();
  return {
    providerId: data.providerId,
    name: data.brandName || branding.name,
    logoUrl: data.logoUrl || branding.logoUrl,
    primaryColor: data.primaryColor || branding.primaryColor,
    secondaryColor: data.secondaryColor || branding.secondaryColor,
    accentColor: data.accentColor || "#10b981",
    customDomain: data.customDomain ?? null,
    footerText: data.footerText || branding.footerText,
  };
}
