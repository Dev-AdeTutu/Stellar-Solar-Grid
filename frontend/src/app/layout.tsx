import type { Metadata } from "next";
import { ToastProvider } from "@/components/ToastProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stellar SolarGrid",
  description: "Pay-as-you-go solar energy on the Stellar blockchain",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
