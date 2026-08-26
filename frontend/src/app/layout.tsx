import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ToastProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OfflineBanner } from "@/components/OfflineBanner";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stellar SolarGrid",
  description: "Pay-as-you-go solar energy on the Stellar blockchain",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#f5b300",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorBoundary>
          <ToastProvider>
            <ServiceWorkerRegister />
            <OfflineBanner />
            {children}
          </ToastProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
