import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ToastProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OfflineBanner } from "@/components/OfflineBanner";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { I18nProvider } from "@/components/I18nProvider";
import { ContractPauseBanner } from "@/components/ContractPauseBanner";
import { Footer } from "@/components/Footer";
import { branding, brandingCssVars } from "@/lib/branding";
import "./globals.css";

export const metadata: Metadata = {
  title: branding.name,
  description: "Pay-as-you-go solar energy on the Stellar blockchain",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#f5b300",
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
          <ToastProvider>
            <ServiceWorkerRegister />
            <OfflineBanner />
            {children}
          </ToastProvider>
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
