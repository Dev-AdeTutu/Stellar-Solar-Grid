import { describe, it, expect, beforeEach } from "vitest";
import {
  generateWhiteLabelMobileConfig,
  getProviderBranding,
  getProviderBrandingByDomain,
  renderBrandedEmailTemplate,
  resetBrandingStore,
  upsertProviderBranding,
} from "../src/lib/providerBranding.js";

describe("White-Label Provider Customization (#1005)", () => {
  beforeEach(() => {
    resetBrandingStore();
  });

  it("stores and retrieves provider branding by ID and custom domain", () => {
    const saved = upsertProviderBranding("sunpower-africa", {
      brandName: "SunPower Africa",
      logoUrl: "https://cdn.sunpower.example/logo.png",
      primaryColor: "#ff6600",
      secondaryColor: "#003366",
      accentColor: "#22c55e",
      customDomain: "portal.sunpower.example.com",
      supportEmail: "help@sunpower.example.com",
      footerText: "SunPower Clean Grid",
      mobileAppBundleId: "com.sunpower.grid",
    });

    expect(saved.brandName).toBe("SunPower Africa");
    expect(getProviderBranding("sunpower-africa")?.primaryColor).toBe("#ff6600");
    expect(getProviderBrandingByDomain("portal.sunpower.example.com")?.providerId).toBe(
      "sunpower-africa"
    );
  });

  it("renders branded email HTML using provider logo and colors", () => {
    const branding = upsertProviderBranding("ecogrid", {
      brandName: "EcoGrid",
      logoUrl: "https://ecogrid.example/logo.svg",
      primaryColor: "#16a34a",
      secondaryColor: "#0f172a",
    });

    const html = renderBrandedEmailTemplate(branding, "Welcome", "<p>Hello Customer</p>");
    expect(html).toContain("EcoGrid");
    expect(html).toContain("#16a34a");
    expect(html).toContain("https://ecogrid.example/logo.svg");
  });

  it("generates white-label mobile app build configuration", () => {
    const branding = upsertProviderBranding("helios", {
      brandName: "Helios Solar",
      primaryColor: "#eab308",
      secondaryColor: "#1e293b",
      mobileAppBundleId: "io.helios.solar",
    });

    const mobileConfig = generateWhiteLabelMobileConfig(branding);
    expect(mobileConfig.name).toBe("Helios Solar");
    expect((mobileConfig.ios as any).bundleIdentifier).toBe("io.helios.solar");
  });
});
