import * as StellarSdk from "@stellar/stellar-sdk";
import { contractCalls } from "./metrics.js";

const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
export const NETWORK_PASSPHRASE =
  NETWORK === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

export const RPC_URL =
  NETWORK === "mainnet"
    ? "https://soroban-rpc.stellar.org"
    : "https://soroban-testnet.stellar.org";

export const HORIZON_URL =
  process.env.HORIZON_URL ??
  (NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

export const CONTRACT_ID = process.env.CONTRACT_ID!;
export const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

// Load keypair once at module init. The raw secret string is never referenced again.
const adminKeypair = StellarSdk.Keypair.fromSecret(process.env.ADMIN_SECRET_KEY!);

/**
 * Poll until a submitted transaction reaches SUCCESS or FAILED.
 * Throws a descriptive error on FAILED status or when maxAttempts is exhausted.
 */
export async function waitForConfirmation(
  hash: string,
  maxAttempts = 10,
  pollIntervalMs = 2_000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await server.getTransaction(hash);
    if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) return;
    if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${hash}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Transaction timed out: ${hash}`);
}

/** Submit a signed contract invocation from the admin keypair. */
export async function adminInvoke(
  method: string,
  args: StellarSdk.xdr.ScVal[],
  maxAttempts = Number(process.env.TX_MAX_ATTEMPTS ?? 15),
  pollIntervalMs = Number(process.env.TX_POLL_INTERVAL_MS ?? 2_000)
): Promise<string> {
  const account = await server.getAccount(adminKeypair.publicKey());
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }

  tx = StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
  tx.sign(adminKeypair);

  constructor(config: {
    rpcUrl: string;
    adminSecret: string;
    contractId: string;
    network: string;
  }) {
    this.server = new StellarSdk.SorobanRpc.Server(config.rpcUrl);
    // Load keypair once. The raw secret string is not referenced after this.
    this.adminKeypair = StellarSdk.Keypair.fromSecret(config.adminSecret);
    this.contractId = config.contractId;
    this.networkPassphrase = config.network;
  }

  const hash = sendResult.hash;
  try {
    await waitForConfirmation(hash, maxAttempts, pollIntervalMs);
    contractCalls.inc({ method, status: "success" });
    return hash;
  } catch (err) {
    contractCalls.inc({ method, status: "error" });
    throw err;
  }
}

    const sim = await this.server.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }
    return (sim as any).result?.retval;
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
