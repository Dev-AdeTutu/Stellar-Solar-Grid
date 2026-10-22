import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use node environment (no DOM)
    environment: "node",
    // Only run files named *.integration.test.ts — the other test files in
    // tests/ are plain tsx scripts (scrub, cors, processMessage) that are not
    // vitest suites and should continue to be invoked via `npm run test:*`.
    //
    // Voice assistant tests (e.g. tests/voice-assistant.integration.test.ts)
    // follow this same `*.integration.test.ts` convention, so they are picked
    // up by this pattern automatically — no separate include entry needed.
    include: ["tests/**/*.integration.test.ts"],
    // 30-second timeout for integration tests. This is sufficient for the
    // voice assistant payment-confirmation tests, which may hit the contract
    // mock; the mock resolves locally and does not perform real network I/O.
    testTimeout: 30_000,
  },
});