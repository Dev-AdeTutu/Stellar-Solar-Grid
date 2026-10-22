import Database from "better-sqlite3";
import path from "node:path";

export interface ProviderBranding {
  providerId: string;
  brandName: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  customDomain: string | null;
  supportEmail: string | null;
  footerText: string | null;
  mobileAppBundleId: string | null;
  updatedAt: string;
}

export interface UpsertProviderBrandingInput {
  brandName: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor?: string;
  customDomain?: string | null;
  supportEmail?: string | null;
  footerText?: string | null;
  mobileAppBundleId?: string | null;
}

export const PROVIDER_BRANDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_branding (
  provider_id TEXT PRIMARY KEY,
  brand_name TEXT NOT NULL,
  logo_url TEXT NOT NULL DEFAULT '',
  primary_color TEXT NOT NULL DEFAULT '#f59e0b',
  secondary_color TEXT NOT NULL DEFAULT '#0ea5e9',
  accent_color TEXT NOT NULL DEFAULT '#10b981',
  custom_domain TEXT UNIQUE,
  support_email TEXT,
  footer_text TEXT,
  mobile_app_bundle_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_branding_domain ON provider_branding(custom_domain);
`;

let dbInstance: Database.Database | null = null;

export function getBrandingDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = process.env.BRANDING_DB_PATH || ":memory:";
    dbInstance = new Database(dbPath === ":memory:" ? ":memory:" : path.resolve(dbPath));
    dbInstance.exec(PROVIDER_BRANDING_SCHEMA_SQL);
  }
  return dbInstance;
}

export function resetBrandingStore(): void {
  const db = getBrandingDb();
  db.exec("DELETE FROM provider_branding;");
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function validateBrandingInput(input: UpsertProviderBrandingInput): string | null {
  if (!input.brandName || input.brandName.trim().length === 0) {
    return "brandName is required";
  }
  if (!HEX_COLOR_RE.test(input.primaryColor)) {
    return "primaryColor must be a valid 6-digit hex color (e.g. #f59e0b)";
  }
  if (!HEX_COLOR_RE.test(input.secondaryColor)) {
    return "secondaryColor must be a valid 6-digit hex color (e.g. #0ea5e9)";
  }
  if (input.accentColor && !HEX_COLOR_RE.test(input.accentColor)) {
    return "accentColor must be a valid 6-digit hex color";
  }
  return null;
}

function mapRow(row: any): ProviderBranding {
  return {
    providerId: row.provider_id,
    brandName: row.brand_name,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    accentColor: row.accent_color,
    customDomain: row.custom_domain ?? null,
    supportEmail: row.support_email ?? null,
    footerText: row.footer_text ?? null,
    mobileAppBundleId: row.mobile_app_bundle_id ?? null,
    updatedAt: row.updated_at,
  };
}

export function upsertProviderBranding(
  providerId: string,
  input: UpsertProviderBrandingInput
): ProviderBranding {
  const err = validateBrandingInput(input);
  if (err) {
    throw new Error(err);
  }

  const db = getBrandingDb();
  const updatedAt = new Date().toISOString();
  const domain = input.customDomain ? input.customDomain.trim().toLowerCase() : null;

  const stmt = db.prepare(`
    INSERT INTO provider_branding (
      provider_id, brand_name, logo_url, primary_color, secondary_color,
      accent_color, custom_domain, support_email, footer_text, mobile_app_bundle_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      brand_name = excluded.brand_name,
      logo_url = excluded.logo_url,
      primary_color = excluded.primary_color,
      secondary_color = excluded.secondary_color,
      accent_color = excluded.accent_color,
      custom_domain = excluded.custom_domain,
      support_email = excluded.support_email,
      footer_text = excluded.footer_text,
      mobile_app_bundle_id = excluded.mobile_app_bundle_id,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    providerId,
    input.brandName.trim(),
    input.logoUrl?.trim() ?? "",
    input.primaryColor,
    input.secondaryColor,
    input.accentColor ?? "#10b981",
    domain,
    input.supportEmail ?? null,
    input.footerText ?? null,
    input.mobileAppBundleId ?? null,
    updatedAt
  );

  return getProviderBranding(providerId)!;
}

export function getProviderBranding(providerId: string): ProviderBranding | null {
  const db = getBrandingDb();
  const row = db
    .prepare("SELECT * FROM provider_branding WHERE provider_id = ?")
    .get(providerId);
  return row ? mapRow(row) : null;
}

export function getProviderBrandingByDomain(domain: string): ProviderBranding | null {
  const db = getBrandingDb();
  const normalized = domain.trim().toLowerCase();
  const row = db
    .prepare("SELECT * FROM provider_branding WHERE custom_domain = ?")
    .get(normalized);
  return row ? mapRow(row) : null;
}

export function renderBrandedEmailTemplate(
  branding: ProviderBranding,
  subject: string,
  bodyHtml: string
): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${subject}</title>
  </head>
  <body style="font-family: sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-top: 6px solid ${branding.primaryColor};">
      <header style="padding: 20px; background: ${branding.secondaryColor}; color: #ffffff; display: flex; align-items: center;">
        ${branding.logoUrl ? `<img src="${branding.logoUrl}" alt="${branding.brandName}" style="max-height: 40px; margin-right: 12px;" />` : ""}
        <h1 style="margin: 0; font-size: 20px;">${branding.brandName}</h1>
      </header>
      <main style="padding: 24px; color: #1e293b;">
        ${bodyHtml}
      </main>
      <footer style="padding: 16px 24px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
        <p>${branding.footerText || `Powered by ${branding.brandName}`}</p>
        ${branding.supportEmail ? `<p>Contact support: <a href="mailto:${branding.supportEmail}" style="color: ${branding.primaryColor};">${branding.supportEmail}</a></p>` : ""}
      </footer>
    </div>
  </body>
</html>`;
}

export function generateWhiteLabelMobileConfig(branding: ProviderBranding): Record<string, unknown> {
  const slug = branding.providerId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    name: branding.brandName,
    slug: `solar-grid-${slug}`,
    primaryColor: branding.primaryColor,
    icon: branding.logoUrl || "./assets/icon.png",
    ios: {
      bundleIdentifier: branding.mobileAppBundleId || `com.stellarsolargrid.${slug.replace(/-/g, "")}`,
    },
    android: {
      package: branding.mobileAppBundleId || `com.stellarsolargrid.${slug.replace(/-/g, "")}`,
    },
    extra: {
      providerId: branding.providerId,
      customDomain: branding.customDomain,
      theme: {
        primaryColor: branding.primaryColor,
        secondaryColor: branding.secondaryColor,
        accentColor: branding.accentColor,
      },
    },
  };
}
