import { branding } from "@/lib/branding";

/**
 * #764 — Footer text is white-label configurable via
 * NEXT_PUBLIC_BRAND_FOOTER_TEXT; falls back to a generic copyright line
 * using the configured brand name when unset.
 */
export function Footer() {
  const text = branding.footerText || `© ${new Date().getFullYear()} ${branding.name}`;

  return (
    <footer className="border-t border-white/10 px-4 py-6 text-center text-xs text-gray-400 sm:px-6">
      {text}
    </footer>
  );
}
