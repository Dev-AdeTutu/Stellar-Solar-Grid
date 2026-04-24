import * as StellarSdk from "@stellar/stellar-sdk";
import { useWalletStore } from "@/store/walletStore";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL!;
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID!;
const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE!;

const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

export interface MeterData {
  owner: string;
  active: boolean;
  balance: bigint;
  units_used: bigint;
  plan: string;
  last_payment: bigint;
}

export async function fetchMeter(meterId: string): Promise<MeterData> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  // Use a throwaway keypair for read-only simulation
  const keypair = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(keypair.publicKey(), "0");

  const tx = new StellarSdk.TransactionBuilder(account, {
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

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = (sim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new Error("No result from contract");
  return StellarSdk.scValToNative(retval) as MeterData;
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
