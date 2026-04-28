import * as StellarSdk from "@stellar/stellar-sdk";
import { useWalletStore } from "@/store/walletStore";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL!;
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID!;
const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE!;

const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

export interface MeterData {
  version: number;
  owner: string;
  active: boolean;
  units_used: bigint;
  plan: string;
  last_payment: bigint;
  expires_at: bigint;
  balance: bigint; // Fetched separately via get_meter_balance
}

export async function fetchMeter(meterId: string): Promise<MeterData> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  // Use a throwaway keypair for read-only simulation
  const keypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(keypair.publicKey(), "0");

  // Fetch meter details
  const meterTx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_meter",
        StellarSdk.nativeToScVal(meterId, { type: "symbol" })
      )
    )
    .setTimeout(30)
    .build();

  const meterSim = await server.simulateTransaction(meterTx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(meterSim)) {
    throw new Error(meterSim.error);
  }
  const meterRetval = (meterSim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!meterRetval) throw new Error("No result from get_meter");
  const meterData = StellarSdk.scValToNative(meterRetval);

  // Fetch meter balance separately
  const balanceTx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_meter_balance",
        StellarSdk.nativeToScVal(meterId, { type: "symbol" })
      )
    )
    .setTimeout(30)
    .build();

  const balanceSim = await server.simulateTransaction(balanceTx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(balanceSim)) {
    throw new Error(balanceSim.error);
  }
  const balanceRetval = (balanceSim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!balanceRetval) throw new Error("No result from get_meter_balance");
  const balance = StellarSdk.scValToNative(balanceRetval);

  return {
    ...meterData,
    balance: BigInt(balance),
  } as MeterData;
}

/**
 * Build, simulate, sign (via connected wallet), and submit a contract call.
 * Throws raw errors — callers should wrap with parseWalletError().
 */
export async function contractInvoke(
  sourceAddress: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const account = await server.getAccount(sourceAddress);

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

  // Sign via wallet (Freighter rejection throws here)
  const { signTransaction } = useWalletStore.getState();
  const signedXdr = await signTransaction(tx.toXDR());

  const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const result = await server.sendTransaction(signedTx);

  if (result.status === "ERROR") {
    throw new Error(`Transaction failed: ${result.errorResult}`);
  }
  return result.hash;
}

/** Return all meter IDs registered under the given owner address. */
export async function fetchMetersByOwner(ownerAddress: string): Promise<string[]> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const keypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(keypair.publicKey(), "0");

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_meters_by_owner",
        StellarSdk.nativeToScVal(ownerAddress, { type: "address" })
      )
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = (sim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) return [];
  return StellarSdk.scValToNative(retval) as string[];
}

/** Check if a meter currently has active energy access. */
export async function checkMeterAccess(meterId: string): Promise<boolean> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const keypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(keypair.publicKey(), "0");

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "check_access",
        StellarSdk.nativeToScVal(meterId, { type: "symbol" })
      )
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = (sim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) return false;
  return StellarSdk.scValToNative(retval) as boolean;
}

/** Fetch all registered meters (admin only). */
export async function fetchAllMeters(): Promise<MeterData[]> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const keypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(keypair.publicKey(), "0");

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_all_meters"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = (sim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) return [];
  
  const rawMeters = StellarSdk.scValToNative(retval) as any[];
  return rawMeters.map((m) => ({
    ...m,
    balance: 0n, // Balance isn't stored in the Meter struct anymore, but kept for UI compatibility
  })) as MeterData[];
}
