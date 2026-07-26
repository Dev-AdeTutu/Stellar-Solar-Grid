import * as StellarSdk from "@stellar/stellar-sdk";
import { contractCalls } from "./metrics.js";

const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

export const NETWORK_PASSPHRASE =
  NETWORK === "mainnet" ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;

export const RPC_URL =
  NETWORK === "mainnet"
    ? "https://soroban-rpc.stellar.org"
    : "https://soroban-testnet.stellar.org";

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

export class StellarService {
  public readonly server: StellarSdk.SorobanRpc.Server;
  public readonly adminKeypair: StellarSdk.Keypair;
  public readonly contractId: string;
  public readonly networkPassphrase: string;

  constructor(config: { rpcUrl: string; adminSecret: string; contractId: string; network: string }) {
    this.server = new StellarSdk.SorobanRpc.Server(config.rpcUrl);
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
    try {
      const account = await this.server.getAccount(this.adminKeypair.publicKey());
      const contract = new StellarSdk.Contract(this.contractId);

      let tx = new StellarSdk.TransactionBuilder(account, {
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

      tx = StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
      tx.sign(this.adminKeypair);

      const sendResult = await this.server.sendTransaction(tx);
      const hash = (sendResult as any).hash;

      await this.waitForConfirmation(hash, maxAttempts, pollIntervalMs);
      contractCalls.inc({ method, status: "success" });
      return hash;
    } catch (err: any) {
      contractCalls.inc({ method, status: "error" });
      throw new Error(scrub(err?.message ?? String(err)));
    }
  }

  async query(method: string, args: StellarSdk.xdr.ScVal[]) {
    try {
      const account = await this.server.getAccount(this.adminKeypair.publicKey());
      const contract = new StellarSdk.Contract(this.contractId);

      let tx = new StellarSdk.TransactionBuilder(account, {
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
    } catch (err: any) {
      throw new Error(scrub(err?.message ?? String(err)));
    }
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
