import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        solar: {
          yellow: "#F5A623",
          dark: "var(--color-bg-primary)",
          accent: "var(--color-bg-card)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
