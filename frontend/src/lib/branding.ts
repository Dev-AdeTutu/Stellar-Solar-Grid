import { env } from "@/lib/env";

/**
 * #764 — White-label branding config for energy providers running their own
 * deployment of the dashboard. Sourced from NEXT_PUBLIC_BRAND_* env vars
 * (see .env.example) rather than a database, matching how the rest of the
 * app is configured (fee margins, rate limits, etc.) — there's no
 * multi-tenant provider model here, just one deployment per provider, so a
 * build-time/deploy-time config value is simpler than a settings UI backed
 * by storage and file uploads.
 */
export interface BrandingConfig {
  name: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  footerText?: string;
}

export const branding: BrandingConfig = {
  name: env.NEXT_PUBLIC_BRAND_NAME,
  logoUrl: env.NEXT_PUBLIC_BRAND_LOGO_URL,
  primaryColor: env.NEXT_PUBLIC_BRAND_PRIMARY_COLOR,
  secondaryColor: env.NEXT_PUBLIC_BRAND_SECONDARY_COLOR,
  footerText: env.NEXT_PUBLIC_BRAND_FOOTER_TEXT,
};

/**
 * CSS custom properties driving themed colors app-wide (see globals.css'
 * `--color-brand-primary`/`--color-brand-secondary` and
 * tailwind.config.ts's `solar.yellow`/`solar.secondary`). Applied as an
 * inline style on <html> in layout.tsx so a provider's configured colors
 * take effect without a rebuild.
 */
export function brandingCssVars(config: BrandingConfig = branding): Record<string, string> {
  return {
    "--color-brand-primary": config.primaryColor,
    "--color-brand-secondary": config.secondaryColor,
  };
}
