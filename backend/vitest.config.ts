import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use node environment (no DOM)
    environment: "node",
    // Only run files named *.integration.test.ts — the other test files in
    // tests/ are plain tsx scripts (scrub, cors, processMessage) that are not
    // vitest suites and should continue to be invoked via `npm run test:*`.
    include: ["tests/**/*.integration.test.ts"],
    // 30-second timeout for integration tests
    testTimeout: 30_000,
  },
});
