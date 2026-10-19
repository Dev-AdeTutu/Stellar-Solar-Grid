/**
 * #761 — Circuit breaker for Stellar RPC calls.
 *
 * When the Stellar RPC network is down or slow, every request would
 * otherwise wait out its own timeout before failing, and callers keep
 * hammering a struggling endpoint. This wraps all Stellar RPC traffic in a
 * single opossum breaker so that once failures pile up we stop sending new
 * requests for a cool-off period and fail fast instead.
 *
 * This is deliberately a *different* layer from RpcPool's per-endpoint
 * failover breaker (backend/src/lib/rpcPool.ts): RpcPool decides which of
 * several configured RPC URLs to try next. This breaker decides whether to
 * attempt the Stellar RPC call *at all* — it trips only once the pool has
 * exhausted its failover options and calls are still failing.
 */
import CircuitBreaker from "opossum";
import { logger } from "./logger.js";
import {
  rpcCircuitBreakerState,
  rpcCircuitBreakerTrips,
  rpcCircuitBreakerRejections,
} from "./metrics.js";

export class CircuitOpenError extends Error {
  code = "CIRCUIT_OPEN";
  constructor(message = "Stellar RPC circuit breaker is open — RPC calls are temporarily suspended") {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// A single request that fails after this many ms counts as a failure for
// breaker purposes, independent of any per-call timeout the caller sets.
const BREAKER_TIMEOUT_MS = Number(process.env.RPC_CIRCUIT_TIMEOUT_MS ?? 20_000);
// Minimum number of calls in the rolling window before the breaker will
// evaluate the error rate — approximates "N consecutive failures" without
// tripping on a single unlucky request during low traffic.
const FAILURE_THRESHOLD = Number(process.env.RPC_CIRCUIT_FAILURE_THRESHOLD ?? 5);
// Cool-off period before the breaker allows a single trial ("half-open") request.
const RESET_TIMEOUT_MS = Number(process.env.RPC_CIRCUIT_RESET_MS ?? 30_000);

export interface RpcBreakerOptions {
  name?: string;
  timeout?: number;
  errorThresholdPercentage?: number;
  volumeThreshold?: number;
  resetTimeout?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
}

/**
 * Builds a breaker wired to the shared metrics/logging. Exported (rather
 * than only the module singleton below) so tests can construct one with a
 * small threshold/reset window instead of waiting out production defaults.
 */
export function createRpcBreaker(opts: RpcBreakerOptions = {}): CircuitBreaker {
  const breaker = new CircuitBreaker(async (fn: () => Promise<unknown>) => fn(), {
    name: opts.name ?? "stellar-rpc",
    timeout: opts.timeout ?? BREAKER_TIMEOUT_MS,
    // opossum trips when errorRate > errorThresholdPercentage (strictly
    // greater than) — 99 (not 100) so a 100% failure rate over the rolling
    // window actually trips it; volumeThreshold is what gives us the
    // "N consecutive failures" behaviour (see comment on FAILURE_THRESHOLD).
    errorThresholdPercentage: opts.errorThresholdPercentage ?? 99,
    volumeThreshold: opts.volumeThreshold ?? FAILURE_THRESHOLD,
    resetTimeout: opts.resetTimeout ?? RESET_TIMEOUT_MS,
    rollingCountTimeout: opts.rollingCountTimeout ?? 60_000,
    rollingCountBuckets: opts.rollingCountBuckets ?? 10,
  });

  // Deliberately no `.fallback()` here: opossum invokes the fallback on
  // *every* individual call failure, not only when the breaker trips open —
  // which would swallow real per-call errors (e.g. a genuine contract
  // error) behind a generic "circuit open" message even while closed.
  // Instead, fireBreaker() below distinguishes "breaker is open" from
  // "the call itself failed" after the fact.

  breaker.on("open", () => {
    rpcCircuitBreakerState.set(1);
    rpcCircuitBreakerTrips.inc();
    logger.error(
      { resetTimeoutMs: opts.resetTimeout ?? RESET_TIMEOUT_MS },
      "Stellar RPC circuit breaker OPEN — suspending RPC calls",
    );
  });

  breaker.on("halfOpen", () => {
    rpcCircuitBreakerState.set(0.5);
    logger.warn("Stellar RPC circuit breaker HALF-OPEN — allowing a trial request");
  });

  breaker.on("close", () => {
    rpcCircuitBreakerState.set(0);
    logger.info("Stellar RPC circuit breaker CLOSED — RPC calls resumed");
  });

  breaker.on("reject", () => {
    rpcCircuitBreakerRejections.inc({ outcome: "rejected" });
  });

  return breaker;
}

const rpcBreaker = createRpcBreaker();

/**
 * Fires `fn` through `breaker`, translating opossum's own "breaker is open"
 * rejection (`EOPENBREAKER`) into CircuitOpenError. Any other rejection is
 * the real error from `fn` itself and is rethrown as-is.
 */
export async function fireBreaker<T>(breaker: CircuitBreaker, fn: () => Promise<T>): Promise<T> {
  try {
    return await (breaker.fire(fn) as Promise<T>);
  } catch (err: any) {
    if (err?.code === "EOPENBREAKER") {
      throw new CircuitOpenError();
    }
    throw err;
  }
}

/** Run `fn` through the shared Stellar RPC circuit breaker. */
export async function withRpcBreaker<T>(fn: () => Promise<T>): Promise<T> {
  return fireBreaker(rpcBreaker, fn);
}

export function getCircuitState(breaker: CircuitBreaker = rpcBreaker): "open" | "half-open" | "closed" {
  if (breaker.opened) return "open";
  if (breaker.halfOpen) return "half-open";
  return "closed";
}

export function recordCacheServed(): void {
  rpcCircuitBreakerRejections.inc({ outcome: "cached" });
}

export { rpcBreaker };
