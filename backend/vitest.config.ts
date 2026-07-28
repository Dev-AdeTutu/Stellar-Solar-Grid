import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ESM project — forks pool avoids VM module issues with native ESM
    pool: "forks",
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
