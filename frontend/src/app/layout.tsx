import type { Metadata } from "next";
import { ToastProvider } from "@/components/ToastProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { I18nProvider } from "@/components/I18nProvider";
import { ContractPauseBanner } from "@/components/ContractPauseBanner";
import { Footer } from "@/components/Footer";
import { branding, brandingCssVars } from "@/lib/branding";
import "./globals.css";

export const metadata: Metadata = {
  title: branding.name,
  description: "Pay-as-you-go solar energy on the Stellar blockchain",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" style={brandingCssVars() as React.CSSProperties}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const saved = localStorage.getItem('theme') || 'dark';
                document.documentElement.setAttribute('data-theme', saved);
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ErrorBoundary>
          <I18nProvider>
            <ContractPauseBanner />
            <ToastProvider>{children}</ToastProvider>
            <Footer />
          </I18nProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
