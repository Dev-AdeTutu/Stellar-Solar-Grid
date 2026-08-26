import type { Metadata } from "next";
import { ToastProvider } from "@/components/ToastProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stellar SolarGrid",
  description: "Pay-as-you-go solar energy on the Stellar blockchain",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ErrorBoundary>
          <ToastProvider>{children}</ToastProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
