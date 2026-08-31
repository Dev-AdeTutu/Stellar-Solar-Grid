import { describe, it, expect } from "vitest";
import {
  createRpcBreaker,
  fireBreaker,
  getCircuitState,
  CircuitOpenError,
} from "../src/lib/circuitBreaker.js";

// #761 — each test builds its own breaker via createRpcBreaker() with a
// small threshold/reset window so tests stay fast and independent, rather
// than sharing (and fighting over) the module's production singleton.
describe("Stellar RPC circuit breaker", () => {
  function buildBreaker() {
    return createRpcBreaker({
      name: `test-${Math.random()}`,
      volumeThreshold: 3,
      resetTimeout: 50,
      timeout: 1000,
    });
  }

  it("stays closed and surfaces the underlying error below the failure threshold", async () => {
    const breaker = buildBreaker();
    await expect(fireBreaker(breaker, () => Promise.reject(new Error("rpc down")))).rejects.toThrow(
      "rpc down",
    );
    expect(getCircuitState(breaker)).toBe("closed");
  });

  it("opens after the configured number of consecutive failures and fast-fails further calls", async () => {
    const breaker = buildBreaker();
    const failing = () => Promise.reject(new Error("rpc down"));

    for (let i = 0; i < 3; i++) {
      await expect(fireBreaker(breaker, failing)).rejects.toThrow("rpc down");
    }

    expect(getCircuitState(breaker)).toBe("open");
    // Once open, calls are rejected immediately with CircuitOpenError instead
    // of invoking `failing` again — the whole point of the breaker.
    await expect(fireBreaker(breaker, failing)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("half-opens after the reset timeout and closes again once a trial call succeeds", async () => {
    const breaker = buildBreaker();
    const failing = () => Promise.reject(new Error("rpc down"));
    for (let i = 0; i < 3; i++) {
      await expect(fireBreaker(breaker, failing)).rejects.toThrow();
    }
    expect(getCircuitState(breaker)).toBe("open");

    await new Promise((r) => setTimeout(r, 80));

    await expect(fireBreaker(breaker, () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(getCircuitState(breaker)).toBe("closed");
  });
});
