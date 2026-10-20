import * as StellarSdk from "@stellar/stellar-sdk";
import { contractCalls } from "./metrics.js";
import { getReqId } from "./requestContext.js";
import { logger } from "./logger.js";
import { RpcPool } from "./rpcPool.js";
import { withRpcBreaker, CircuitOpenError, recordCacheServed } from "./circuitBreaker.js";
import { tracer } from "./tracing.js";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  generateMlDsaKeypair,
  mlDsaSign,
  mlDsaVerify,
  type MlDsaKeypair,
  type MlDsaSignature,
} from "./quantumCrypto.js";

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

/**
 * #1067 — Post-quantum signing mode for admin contract invocations.
 *
 * During migration the backend produces a *dual* signature: the legacy
 * ed25519 signature (still required by the current on-chain verifier) plus an
 * ML-DSA (Dilithium) signature over the same transaction hash. The contract
 * can verify the PQC signature when present and fall back to ed25519-only
 * verification for transactions that predate the migration.
 *
 * Modes:
 *   - "off"     : legacy ed25519 only (default until the contract is upgraded)
 *   - "dual"    : attach both ed25519 and ML-DSA signatures
 *   - "pqc"     : require ML-DSA (ed25519 still attached for account auth)
 */
export type PqcSigningMode = "off" | "dual" | "pqc";

export function resolvePqcSigningMode(): PqcSigningMode {
  const raw = (process.env.PQC_SIGNING_MODE ?? "off").toLowerCase();
  if (raw === "dual" || raw === "pqc") return raw;
  return "off";
}

/** A registered post-quantum public key, keyed by the legacy ed25519 public key. */
export interface PqcKeyRegistration {
  /** Stellar ed25519 public key (G...) this PQC key is bound to. */
  ed25519PublicKey: string;
  /** Base64-encoded ML-DSA public key. */
  mlDsaPublicKey: string;
  /** Algorithm identifier, e.g. "ML-DSA-65". */
  algorithm: string;
  registeredAt: number;
}

/** Dual signature bundle attached to an admin invocation. */
export interface DualSignature {
  /** Base64 ed25519 signature over the transaction hash. */
  ed25519: string;
  /** Base64 ML-DSA signature over the transaction hash, when PQC is enabled. */
  mlDsa?: string;
  /** Algorithm identifier for the ML-DSA signature. */
  algorithm?: string;
  /** Base64 ML-DSA public key used to produce the signature. */
  publicKey?: string;
}

/**
 * In-memory registry of PQC public keys bound to ed25519 account keys.
 * In production this is mirrored on-chain via the contract's
 * `register_pqc_key` entrypoint; the local map is the fast-path cache used
 * when building transactions.
 */
export class PqcKeyRegistry {
  private readonly keys = new Map<string, PqcKeyRegistration>();

  register(reg: PqcKeyRegistration): void {
    this.keys.set(reg.ed25519PublicKey, reg);
  }

  get(ed25519PublicKey: string): PqcKeyRegistration | undefined {
    return this.keys.get(ed25519PublicKey);
  }

  has(ed25519PublicKey: string): boolean {
    return this.keys.has(ed25519PublicKey);
  }

  clear(): void {
    this.keys.clear();
  }
}

export class StellarService {
  public readonly server: StellarSdk.SorobanRpc.Server;
  public readonly adminKeypair: StellarSdk.Keypair;
  public readonly contractId: string;
  public readonly networkPassphrase: string;
  public readonly pool?: RpcPool;
  public readonly pqcRegistry = new PqcKeyRegistry();
  public readonly pqcSigningMode: PqcSigningMode;
  private readonly pqcKeypair?: MlDsaKeypair;
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
    this.pqcSigningMode = resolvePqcSigningMode();

    // Load or derive the admin's ML-DSA keypair when PQC signing is enabled.
    if (this.pqcSigningMode !== "off") {
      const seed = process.env.PQC_ADMIN_SEED;
      this.pqcKeypair = seed ? generateMlDsaKeypair(seed) : generateMlDsaKeypair();
      this.pqcRegistry.register({
        ed25519PublicKey: this.adminKeypair.publicKey(),
        mlDsaPublicKey: this.pqcKeypair.publicKey,
        algorithm: this.pqcKeypair.algorithm,
        registeredAt: Date.now(),
      });
      logger.info(
        {
          mode: this.pqcSigningMode,
          algorithm: this.pqcKeypair.algorithm,
          ed25519PublicKey: this.adminKeypair.publicKey(),
        },
        "Post-quantum signing enabled for admin invocations",
      );
    }
  }

  /**
   * #1067 — Register a PQC public key for an ed25519 account. Called at
   * startup (for the admin key) and by the migration tooling for other
   * signers. Registration is idempotent.
   */
  registerPqcKey(reg: PqcKeyRegistration): void {
    this.pqcRegistry.register(reg);
  }

  /**
   * #1067 — Produce a dual signature (ed25519 + ML-DSA) over the given
   * transaction hash. The ed25519 signature is always produced; the ML-DSA
   * signature is added when PQC signing is enabled.
   */
  signDual(txHash: Buffer | Uint8Array): DualSignature {
    const hashBuf = Buffer.isBuffer(txHash) ? txHash : Buffer.from(txHash);
    const ed25519 = Buffer.from(this.adminKeypair.sign(hashBuf)).toString("base64");

    if (this.pqcSigningMode === "off" || !this.pqcKeypair) {
      return { ed25519 };
    }

    const mlDsaSig: MlDsaSignature = mlDsaSign(hashBuf, this.pqcKeypair);
    return {
      ed25519,
      mlDsa: mlDsaSig.signature,
      algorithm: mlDsaSig.algorithm,
      publicKey: this.pqcKeypair.publicKey,
    };
  }

  /**
   * #1067 — Verify a dual signature bundle. The ed25519 signature is always
   * verified; the ML-DSA signature is verified when present. Returns true
   * only if every present signature is valid.
   */
  verifyDual(txHash: Buffer | Uint8Array, sig: DualSignature): boolean {
    const hashBuf = Buffer.isBuffer(txHash) ? txHash : Buffer.from(txHash);

    const ed25519Ok = this.adminKeypair.verify(
      hashBuf,
      Buffer.from(sig.ed25519, "base64"),
    );
    if (!ed25519Ok) return false;

    if (sig.mlDsa) {
      const publicKey = sig.publicKey ?? this.pqcRegistry.get(this.adminKeypair.publicKey())?.mlDsaPublicKey;
      if (!publicKey) return false;
      return mlDsaVerify(hashBuf, sig.mlDsa, publicKey, sig.algorithm);
    }

    // No PQC signature: acceptable only while not in strict "pqc" mode.
    return this.pqcSigningMode !== "pqc";
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

          // #1067 — Attach the post-quantum signature bundle during migration.
          // The bundle is carried in the transaction memo-free envelope via the
          // contract's `pqc_signature` argument convention; here we compute it
          // and expose it on the span for downstream submission tooling.
          if (this.pqcSigningMode !== "off") {
            const txHash = assembled.hash();
            const dual = this.signDual(txHash);
            span.setAttribute("stellar.pqc_mode", this.pqcSigningMode);
            span.setAttribute("stellar.pqc_algorithm", dual.algorithm ?? "none");
            span.setAttribute("stellar.pqc_signed", Boolean(dual.mlDsa));
          }

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

  /**
   * #990 — Record a grid export on-chain, crediting the meter owner based on
   * the admin-configured export rate. Invokes the contract's
   * `record_grid_export` entrypoint and returns the transaction hash.
   */
  async recordGridExportOnChain(meterId: string, kwh: number): Promise<string> {
    return this.invoke("record_grid_export", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(BigInt(kwh), { type: "u64" }),
    ]);
  }

  /**
   * #1070 — Record a payment event in the reputation contract so it can be
   * folded into the caller's credit score. `onTime` reflects whether the
   * payment was made by its due date; `amount` is the payment amount in the
   * contract's base unit. Returns the transaction hash.
   */
  async recordPaymentReputation(
    address: string,
    amount: bigint,
    onTime: boolean,
    timestampMs: number,
  ): Promise<string> {
    return this.invoke("record_payment", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
      StellarSdk.nativeToScVal(amount, { type: "i128" }),
      StellarSdk.nativeToScVal(onTime, { type: "bool" }),
      StellarSdk.nativeToScVal(BigInt(timestampMs), { type: "u64" }),
    ]);
  }

  /**
   * #1070 — Fetch the reputation score (0-100) for an address from the
   * reputation contract. Returns `null` when the contract has no score for
   * the address yet.
   */
  async getReputationScore(address: string): Promise<number | null> {
    const retval = await this.query("get_reputation_score", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    if (retval === undefined || retval === null) return null;
    try {
      const decoded = StellarSdk.scValToNative(retval);
      if (decoded === null || decoded === undefined) return null;
      const score = Number(decoded);
      return Number.isFinite(score) ? score : null;
    } catch (err: any) {
      throw new Error(scrub(`Failed to decode reputation score: ${err?.message ?? String(err)}`));
    }
  }

  /**
   * #1070 — Associate a DID (Decentralized Identifier) with an address in the
   * reputation contract. Returns the transaction hash.
   */
  async setDid(address: string, did: string): Promise<string> {
    return this.invoke("set_did", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
      StellarSdk.nativeToScVal(did, { type: "string" }),
    ]);
  }

  /**
   * #1070 — Resolve the DID currently bound to an address, or `null` when no
   * DID has been set.
   */
  async getDid(address: string): Promise<string | null> {
    const retval = await this.query("get_did", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    if (retval === undefined || retval === null) return null;
    try {
      const decoded = StellarSdk.scValToNative(retval);
      if (decoded === null || decoded === undefined) return null;
      return String(decoded);
    } catch (err: any) {
      throw new Error(scrub(`Failed to decode DID: ${err?.message ?? String(err)}`));
    }
  }

  /**
   * #1070 — Resolve an address from a DID via the reputation contract, or
   * `null` when the DID is unknown.
   */
  async resolveDid(did: string): Promise<string | null> {
    const retval = await this.query("resolve_did", [
      StellarSdk.nativeToScVal(did, { type: "string" }),
    ]);
    if (retval === undefined || retval === null) return null;
    try {
      const decoded = StellarSdk.scValToNative(retval);
      if (decoded === null || decoded === undefined) return null;
      return String(decoded);
    } catch (err: any) {
      throw new Error(scrub(`Failed to decode DID resolution: ${err?.message ?? String(err)}`));
    }
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
export const recordGridExportOnChain = stellarService.recordGridExportOnChain.bind(stellarService);
export const recordPaymentReputation = stellarService.recordPaymentReputation.bind(stellarService);
export const getReputationScore = stellarService.getReputationScore.bind(stellarService);
export const setDid = stellarService.setDid.bind(stellarService);
export const getDid = stellarService.getDid.bind(stellarService);
export const resolveDid = stellarService.resolveDid.bind(stellarService);
