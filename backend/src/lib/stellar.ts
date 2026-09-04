import * as StellarSdk from "@stellar/stellar-sdk";
import { contractCalls } from "./metrics.js";
import { getReqId } from "./requestContext.js";
import { logger } from "./logger.js";
import { RpcPool } from "./rpcPool.js";
import { withRpcBreaker, CircuitOpenError, recordCacheServed } from "./circuitBreaker.js";
import { tracer } from "./tracing.js";
import { SpanStatusCode } from "@opentelemetry/api";

const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

export const NETWORK_PASSPHRASE =
  NETWORK === "mainnet" ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;

export const RPC_URLS: string[] = process.env.STELLAR_RPC_URLS
  ? process.env.STELLAR_RPC_URLS.split(",").map((u) => u.trim()).filter(Boolean)
  : [
      process.env.STELLAR_RPC_URL ??
        (NETWORK === "mainnet"
          ? "https://soroban-rpc.stellar.org"
          : "https://soroban-testnet.stellar.org"),
    ];

export const RPC_URL = RPC_URLS[0];

export const HORIZON_URL =
  process.env.HORIZON_URL ??
  (NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

export const rpcPool = new RpcPool(RPC_URLS);

const SECRET_ENV = process.env.ADMIN_SECRET_KEY ?? "";

export const scrub = (msg: string | undefined): string => {
  try {
    let out = String(msg ?? "");
    if (SECRET_ENV) out = out.replaceAll(SECRET_ENV, "[REDACTED]");
    // public key may be present in messages too
    try {
      if (SECRET_ENV) {
        // try to redact any public key-looking substrings derived from secret
        // best-effort: redact the public key if available at runtime
      }
    } catch {}
    return out;
  } catch {
    return "[REDACTED]";
  }
};

// #761 — last-known-good result per read-only query, served when the RPC
// circuit breaker is open so dashboards degrade to stale data instead of a
// hard failure. Bounded to avoid unbounded growth across the life of the
// process; least-recently-set entries are evicted first.
const QUERY_CACHE_MAX_ENTRIES = Number(process.env.RPC_QUERY_CACHE_MAX_ENTRIES ?? 500);

function buildQueryCacheKey(method: string, args: StellarSdk.xdr.ScVal[]): string {
  return `${method}:${args.map((a) => a.toXDR("base64")).join(",")}`;
}

/**
 * #762 — Pad the assembled transaction fee (classic fee + simulated resource
 * fee) by a safety margin.
 *
 * `simulateTransaction`'s resource-fee estimate is a point-in-time snapshot;
 * actual execution cost can drift when ledger state changes between
 * simulation and submission (e.g. rent bumps on entries touched by the
 * operation). That drift scales with how many ledger entries the operation
 * touches, so a fixed percentage margin on top of the simulated fee scales
 * with it too — a `batch_update_usage` call over many meters gets a
 * proportionally larger cushion than a single-meter update, without needing
 * to special-case batch size.
 */
export function padResourceFee(assembledFee: string): string {
  const marginPct = Number(process.env.RPC_FEE_SAFETY_MARGIN_PCT ?? 20);
  const base = Number(assembledFee);
  if (!Number.isFinite(base) || marginPct <= 0) return assembledFee;
  return String(Math.ceil(base * (1 + marginPct / 100)));
}

export class StellarService {
  public readonly server: StellarSdk.SorobanRpc.Server;
  public readonly adminKeypair: StellarSdk.Keypair;
  public readonly contractId: string;
  public readonly networkPassphrase: string;
  public readonly pool?: RpcPool;
  private readonly queryCache = new Map<string, { value: unknown; storedAt: number }>();

  constructor(config: {
    rpcUrl?: string;
    rpcUrls?: string[];
    rpcPool?: RpcPool;
    adminSecret: string;
    contractId: string;
    network: string;
  }) {
    if (config.rpcPool) {
      this.pool = config.rpcPool;
      this.server = config.rpcPool.createProxy();
    } else if (config.rpcUrls && config.rpcUrls.length > 0) {
      this.pool = new RpcPool(config.rpcUrls);
      this.server = this.pool.createProxy();
    } else if (config.rpcUrl) {
      this.pool = new RpcPool([config.rpcUrl]);
      this.server = this.pool.createProxy();
    } else {
      this.pool = rpcPool;
      this.server = rpcPool.createProxy();
    }
    this.adminKeypair = StellarSdk.Keypair.fromSecret(config.adminSecret);
    this.contractId = config.contractId;
    this.networkPassphrase = config.network;
  }

  private async waitForConfirmation(hash: string, maxAttempts = 10, pollIntervalMs = 2_000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const status = await this.server.getTransaction(hash);
      if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) return;
      if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(scrub(`Transaction failed: ${hash}`));
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(scrub(`Transaction timed out: ${hash}`));
  }

  async invoke(
    method: string,
    args: StellarSdk.xdr.ScVal[],
    maxAttempts = Number(process.env.TX_MAX_ATTEMPTS ?? 15),
    pollIntervalMs = Number(process.env.TX_POLL_INTERVAL_MS ?? 2_000),
  ): Promise<string> {
    const requestId = getReqId();
    logger.debug({ method, requestId }, "Stellar invoke");
    return tracer.startActiveSpan(`stellar.invoke ${method}`, async (span) => {
      span.setAttribute("stellar.method", method);
      span.setAttribute("stellar.op", "invoke");
      try {
        const hash = await withRpcBreaker(async () => {
          const account = await this.server.getAccount(this.adminKeypair.publicKey());
          const contract = new StellarSdk.Contract(this.contractId);

          const tx = new StellarSdk.TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: this.networkPassphrase,
          })
            .addOperation(contract.call(method, ...args))
            .setTimeout(30)
            .build();

          const sim = await this.server.simulateTransaction(tx);
          if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
            throw new Error(scrub(String((sim as any).error ?? sim)));
          }

          let assembled = StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
          const paddedFee = padResourceFee(assembled.fee);
          if (paddedFee !== assembled.fee) {
            assembled = StellarSdk.TransactionBuilder.cloneFrom(assembled, {
              fee: paddedFee,
            }).build();
          }
          assembled.sign(this.adminKeypair);

          const sendResult = await this.server.sendTransaction(assembled);
          const sentHash = (sendResult as any).hash;

          await this.waitForConfirmation(sentHash, maxAttempts, pollIntervalMs);
          return sentHash;
        });
        contractCalls.inc({ method, status: "success" });
        span.setStatus({ code: SpanStatusCode.OK });
        return hash;
      } catch (err: any) {
        contractCalls.inc({ method, status: "error" });
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        if (err instanceof CircuitOpenError) throw err;
        throw new Error(scrub(err?.message ?? String(err)));
      } finally {
        span.end();
      }
    });
  }

  async query(method: string, args: StellarSdk.xdr.ScVal[]) {
    const requestId = getReqId();
    logger.debug({ method, requestId }, "Stellar query");
    const cacheKey = buildQueryCacheKey(method, args);
    return tracer.startActiveSpan(`stellar.query ${method}`, async (span) => {
      span.setAttribute("stellar.method", method);
      span.setAttribute("stellar.op", "query");
      try {
        const retval = await withRpcBreaker(async () => {
          const account = await this.server.getAccount(this.adminKeypair.publicKey());
          const contract = new StellarSdk.Contract(this.contractId);

          const tx = new StellarSdk.TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: this.networkPassphrase,
          })
            .addOperation(contract.call(method, ...args))
            .setTimeout(30)
            .build();

          const sim = await this.server.simulateTransaction(tx);
          if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
            throw new Error(scrub(String((sim as any).error ?? sim)));
          }

          return (sim as any).result?.retval;
        });
        this.rememberQueryResult(cacheKey, retval);
        span.setStatus({ code: SpanStatusCode.OK });
        return retval;
      } catch (err: any) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        if (err instanceof CircuitOpenError) {
          const cached = this.queryCache.get(cacheKey);
          if (cached) {
            logger.warn(
              { method, requestId, cachedAgeMs: Date.now() - cached.storedAt },
              "Stellar RPC circuit open — serving cached query result",
            );
            recordCacheServed();
            span.setAttribute("stellar.served_from_cache", true);
            return cached.value;
          }
          throw err;
        }
        throw new Error(scrub(err?.message ?? String(err)));
      } finally {
        span.end();
      }
    });
  }

  private rememberQueryResult(key: string, value: unknown): void {
    if (this.queryCache.size >= QUERY_CACHE_MAX_ENTRIES && !this.queryCache.has(key)) {
      const oldestKey = this.queryCache.keys().next().value;
      if (oldestKey !== undefined) this.queryCache.delete(oldestKey);
    }
    this.queryCache.delete(key); // re-insert to refresh recency for the eviction order above
    this.queryCache.set(key, { value, storedAt: Date.now() });
  }

  /**
   * Convert a UNIX timestamp (milliseconds) to an approximate Stellar ledger number.
   * Uses Horizon API to find the ledger closest to the given timestamp.
   */
  async timestampToLedger(unixTimestampMs: number): Promise<number> {
    try {
      const horizonUrl =
        this.networkPassphrase === StellarSdk.Networks.PUBLIC
          ? "https://horizon.stellar.org"
          : "https://horizon-testnet.stellar.org";

      const horizonServer = new StellarSdk.Horizon.Server(horizonUrl);
      
      // Convert milliseconds to seconds for Horizon
      const isoTimestamp = new Date(unixTimestampMs).toISOString();
      
      // Query ledgers near the given timestamp
      const ledgers = await horizonServer
        .ledgers()
        .order("desc")
        .limit(200)
        .call();

      let closestLedger = 1;
      let closestDiff = Infinity;

      for (const ledger of ledgers.records) {
        const ledgerTime = new Date(ledger.closed_at).getTime();
        const diff = Math.abs(ledgerTime - unixTimestampMs);

        if (diff < closestDiff) {
          closestDiff = diff;
          closestLedger = ledger.sequence;
        }
      }

      return closestLedger;
    } catch (err: any) {
      throw new Error(scrub(`Failed to convert timestamp to ledger: ${err?.message ?? String(err)}`));
    }
  }
}

// Singleton instance — created once at startup and injected into routes.
export const stellarService = new StellarService({
  rpcUrl: RPC_URL,
  adminSecret: process.env.ADMIN_SECRET_KEY!,
  contractId: process.env.CONTRACT_ID!,
  network: NETWORK_PASSPHRASE,
});

// Back-compat aliases so existing callers (bridge, payments) keep working.
export const CONTRACT_ID = stellarService.contractId;
export const server = stellarService.server;
export const adminInvoke = stellarService.invoke.bind(stellarService);
export const contractQuery = stellarService.query.bind(stellarService);
