import * as StellarSdk from "@stellar/stellar-sdk";
import { logger } from "./logger.js";

export interface EndpointState {
  url: string;
  server: StellarSdk.SorobanRpc.Server;
  healthy: boolean;
  consecutiveFailures: number;
  unhealthySince: number | null;
  priority: number;
}

export interface RpcPoolOptions {
  circuitBreakerThreshold?: number; // consecutive failures to trip (default: 3)
  circuitBreakerResetTimeoutMs?: number; // cool-off before retry (default: 60000 ms)
  healthCheckIntervalMs?: number; // interval for health checking unhealthy endpoints (default: 30000 ms)
}

export class RpcPool {
  private endpoints: EndpointState[] = [];
  private roundRobinIndex = 0;
  private circuitBreakerThreshold: number;
  private circuitBreakerResetTimeoutMs: number;
  private healthCheckIntervalMs: number;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(urls: string[], options: RpcPoolOptions = {}) {
    if (!urls || urls.length === 0) {
      throw new Error("RpcPool requires at least one RPC URL");
    }

    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 3;
    this.circuitBreakerResetTimeoutMs = options.circuitBreakerResetTimeoutMs ?? 60_000;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30_000;

    this.endpoints = urls.map((url, index) => ({
      url,
      server: new StellarSdk.SorobanRpc.Server(url),
      healthy: true,
      consecutiveFailures: 0,
      unhealthySince: null,
      priority: index,
    }));

    logger.info(
      { endpoints: urls, count: urls.length },
      "Initialized Stellar RPC connection pool with failover support",
    );

    this.startHealthCheckLoop();
  }

  public getEndpoints(): ReadonlyArray<Readonly<EndpointState>> {
    return this.endpoints;
  }

  public getHealthStatus(): {
    total: number;
    healthy: number;
    endpoints: Array<{ url: string; healthy: boolean; consecutiveFailures: number; priority: number }>;
  } {
    return {
      total: this.endpoints.length,
      healthy: this.endpoints.filter((e) => this.isEndpointAvailable(e)).length,
      endpoints: this.endpoints.map((e) => ({
        url: e.url,
        healthy: this.isEndpointAvailable(e),
        consecutiveFailures: e.consecutiveFailures,
        priority: e.priority,
      })),
    };
  }

  private isEndpointAvailable(endpoint: EndpointState): boolean {
    if (endpoint.healthy) return true;
    // Check if circuit breaker cool-off period has passed
    if (
      endpoint.unhealthySince &&
      Date.now() - endpoint.unhealthySince >= this.circuitBreakerResetTimeoutMs
    ) {
      return true; // Half-open state
    }
    return false;
  }

  private getOrderedCandidateEndpoints(): EndpointState[] {
    const available = this.endpoints.filter((e) => this.isEndpointAvailable(e));
    if (available.length === 0) {
      // If all are marked unhealthy, fall back to all endpoints in priority order
      logger.warn("All Stellar RPC endpoints are marked unhealthy; attempting fallback to full pool");
      return [...this.endpoints].sort((a, b) => a.priority - b.priority);
    }

    // Sort available endpoints with round-robin offset among healthy endpoints
    const startIndex = this.roundRobinIndex % available.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;

    const ordered: EndpointState[] = [];
    for (let i = 0; i < available.length; i++) {
      ordered.push(available[(startIndex + i) % available.length]);
    }
    return ordered;
  }

  private recordSuccess(endpoint: EndpointState) {
    if (!endpoint.healthy || endpoint.consecutiveFailures > 0) {
      logger.info(
        { url: endpoint.url, previousFailures: endpoint.consecutiveFailures },
        `Stellar RPC endpoint ${endpoint.url} is now HEALTHY`,
      );
    }
    endpoint.healthy = true;
    endpoint.consecutiveFailures = 0;
    endpoint.unhealthySince = null;
  }

  private recordFailure(endpoint: EndpointState, err: any) {
    endpoint.consecutiveFailures++;
    const errMsg = err?.message ?? String(err);
    logger.warn(
      {
        url: endpoint.url,
        consecutiveFailures: endpoint.consecutiveFailures,
        error: errMsg,
      },
      `Stellar RPC request failed on ${endpoint.url} (${endpoint.consecutiveFailures}/${this.circuitBreakerThreshold} failures)`,
    );

    if (endpoint.consecutiveFailures >= this.circuitBreakerThreshold) {
      endpoint.healthy = false;
      endpoint.unhealthySince = Date.now();
      logger.error(
        {
          url: endpoint.url,
          cooldownSec: this.circuitBreakerResetTimeoutMs / 1000,
        },
        `Circuit breaker tripped for Stellar RPC endpoint ${endpoint.url}. Marked UNHEALTHY for ${this.circuitBreakerResetTimeoutMs / 1000}s`,
      );
    }
  }

  public async executeWithFailover<T>(
    operation: (server: StellarSdk.SorobanRpc.Server, endpoint: EndpointState) => Promise<T>,
  ): Promise<T> {
    const candidates = this.getOrderedCandidateEndpoints();
    let lastError: any = null;

    for (const endpoint of candidates) {
      try {
        const result = await operation(endpoint.server, endpoint);
        this.recordSuccess(endpoint);
        return result;
      } catch (err: any) {
        lastError = err;
        this.recordFailure(endpoint, err);
        logger.warn(
          { failedUrl: endpoint.url, remainingCandidates: candidates.length - 1 },
          `Failing over to next available Stellar RPC endpoint...`,
        );
      }
    }

    throw lastError ?? new Error("All Stellar RPC endpoints failed to execute request");
  }

  private startHealthCheckLoop() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      const unhealthyEndpoints = this.endpoints.filter((e) => !e.healthy);
      if (unhealthyEndpoints.length === 0) return;

      for (const endpoint of unhealthyEndpoints) {
        try {
          await endpoint.server.getLatestLedger();
          this.recordSuccess(endpoint);
          logger.info(
            { url: endpoint.url },
            `Health check succeeded. Restored endpoint ${endpoint.url} to HEALTHY state`,
          );
        } catch (err) {
          logger.debug(
            { url: endpoint.url, err: (err as any)?.message },
            `Health check failed for endpoint ${endpoint.url}`,
          );
        }
      }
    }, this.healthCheckIntervalMs);

    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  public stopHealthCheckLoop() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Creates a proxy conforming to StellarSdk.SorobanRpc.Server that delegates calls to executeWithFailover.
   */
  public createProxy(): StellarSdk.SorobanRpc.Server {
    const target = this.endpoints[0].server;
    const pool = this;

    return new Proxy(target, {
      get(originalTarget, prop, receiver) {
        if (prop === "_pool" || prop === "pool") {
          return pool;
        }
        const val = Reflect.get(originalTarget, prop, receiver);
        if (typeof val === "function") {
          return (...args: any[]) => {
            return pool.executeWithFailover((server) => {
              const method = (server as any)[prop];
              if (typeof method !== "function") {
                throw new Error(`Property ${String(prop)} is not a function on SorobanRpc.Server`);
              }
              return method.apply(server, args);
            });
          };
        }
        return val;
      },
    });
  }
}
