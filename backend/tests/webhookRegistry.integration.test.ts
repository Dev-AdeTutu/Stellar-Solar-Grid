/**
 * Covers the webhook circuit breaker: after CIRCUIT_FAILURE_THRESHOLD (10)
 * consecutive delivery failures to a URL, further deliveries to that URL are
 * skipped (no fetch attempt) until the cooldown window elapses.
 */

import { describe, it, expect, beforeEach } from "vitest";

process.env.WEBHOOKS_DB_PATH = ":memory:";

import {
  fireWebhook,
  getCircuitBreakerState,
  resetCircuitBreakers,
} from "../src/lib/webhookRegistry.js";

function installFetchSpy(status: number) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response(status === 200 ? "{}" : "error", { status }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const URL = "https://circuit.example.com/hook";

describe("webhook circuit breaker", () => {
  beforeEach(() => {
    resetCircuitBreakers();
  });

  it("opens after 10 consecutive failures and skips further delivery attempts", async () => {
    const spy = installFetchSpy(500);
    try {
      for (let i = 0; i < 10; i++) {
        await fireWebhook(URL, JSON.stringify({ i }));
      }

      const state = getCircuitBreakerState(URL);
      expect(state.open).toBe(true);
      expect(state.consecutiveFailures).toBeGreaterThanOrEqual(10);

      const callsBeforeEleventh = spy.calls.length;
      await fireWebhook(URL, JSON.stringify({ eleventh: true }));

      // Circuit is open — no additional fetch attempt should have been made.
      expect(spy.calls.length).toBe(callsBeforeEleventh);
    } finally {
      spy.restore();
    }
  });

  it("does not open the circuit for a URL that stays under the failure threshold", async () => {
    const spy = installFetchSpy(500);
    try {
      for (let i = 0; i < 9; i++) {
        await fireWebhook(URL, JSON.stringify({ i }));
      }
      expect(getCircuitBreakerState(URL).open).toBe(false);
    } finally {
      spy.restore();
    }
  });

  it("closes and resumes deliveries once the cooldown window elapses", async () => {
    const failing = installFetchSpy(500);
    try {
      for (let i = 0; i < 10; i++) {
        await fireWebhook(URL, JSON.stringify({ i }));
      }
      expect(getCircuitBreakerState(URL).open).toBe(true);
    } finally {
      failing.restore();
    }

    const realDateNow = Date.now;
    try {
      // Fast-forward past the 5-minute cooldown.
      Date.now = () => realDateNow() + 5 * 60 * 1000 + 1;

      const succeeding = installFetchSpy(200);
      try {
        await fireWebhook(URL, JSON.stringify({ resumed: true }));
        expect(succeeding.calls.length).toBe(1);
        expect(getCircuitBreakerState(URL).open).toBe(false);
        expect(getCircuitBreakerState(URL).consecutiveFailures).toBe(0);
      } finally {
        succeeding.restore();
      }
    } finally {
      Date.now = realDateNow;
    }
  });

  it("a success resets the consecutive-failure count", async () => {
    const failing = installFetchSpy(500);
    try {
      for (let i = 0; i < 5; i++) {
        await fireWebhook(URL, JSON.stringify({ i }));
      }
      expect(getCircuitBreakerState(URL).consecutiveFailures).toBe(5);
    } finally {
      failing.restore();
    }

    const succeeding = installFetchSpy(200);
    try {
      await fireWebhook(URL, JSON.stringify({ ok: true }));
      expect(getCircuitBreakerState(URL).consecutiveFailures).toBe(0);
    } finally {
      succeeding.restore();
    }
  });
});
