import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        solar: {
          // #764 — driven by NEXT_PUBLIC_BRAND_PRIMARY/SECONDARY_COLOR at
          // runtime, see globals.css and lib/branding.ts.
          yellow: "var(--color-brand-primary)",
          secondary: "var(--color-brand-secondary)",
          dark: "var(--color-bg-primary)",
          accent: "var(--color-bg-card)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
