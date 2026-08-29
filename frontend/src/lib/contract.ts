import * as StellarSdk from "@stellar/stellar-sdk";
import { useWalletStore } from "@/store/walletStore";
import { env } from "@/lib/env";

export interface MeterData {
  version: number;
  owner: string;
  active: boolean;
  units_used: bigint;
  plan: string;
  last_payment: bigint;
  expires_at: bigint;
  balance: bigint;
  grace_expires_at?: bigint | null;
  meter_id?: string;
}

const REQUEST_TIMEOUT_MS = env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS;

export class ContractClient {
  private server: StellarSdk.SorobanRpc.Server;
  private contractId: string;
  private networkPassphrase: string;

  constructor(contractId: string, rpcUrl: string, networkPassphrase: string) {
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);
    this.contractId = contractId;
    this.networkPassphrase = networkPassphrase;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  async query(method: string, args: StellarSdk.xdr.ScVal[]): Promise<StellarSdk.xdr.ScVal> {
    const contract = new StellarSdk.Contract(this.contractId);
    const keypair = StellarSdk.Keypair.random();
    const account = new StellarSdk.Account(keypair.publicKey(), "0");

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.withTimeout(this.server.simulateTransaction(tx));
    if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }
    const retval = (sim as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result
      ?.retval;
    if (!retval) throw new Error(`No result from ${method}`);
    return retval;
  }

  async invoke(
    sourceAddress: string,
    method: string,
    args: StellarSdk.xdr.ScVal[],
  ): Promise<string> {
    const contract = new StellarSdk.Contract(this.contractId);
    const account = await this.withTimeout(this.server.getAccount(sourceAddress));

    let tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.withTimeout(this.server.simulateTransaction(tx));
    if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }

    tx = StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();

    const { signTransaction } = useWalletStore.getState();
    const signedXdr = await signTransaction(tx.toXDR());

    const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.withTimeout(this.server.sendTransaction(signedTx));

    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult}`);
    }
    return result.hash;
  }
}

export const client = new ContractClient(
  env.NEXT_PUBLIC_CONTRACT_ID,
  env.NEXT_PUBLIC_RPC_URL,
  env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
);

export async function fetchMeter(meterId: string): Promise<MeterData> {
  const retval = await client.query("get_meter_full", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
  ]);
  const view = StellarSdk.scValToNative(retval) as {
    meter: Omit<MeterData, "balance">;
    balance: bigint;
  };
  return { ...view.meter, balance: view.balance } as MeterData;
}

export async function contractInvoke(
  sourceAddress: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<string> {
  return client.invoke(sourceAddress, method, args);
}

export async function fetchMetersByOwner(ownerAddress: string): Promise<string[]> {
  const retval = await client.query("get_meters_by_owner", [
    StellarSdk.nativeToScVal(ownerAddress, { type: "address" }),
  ]);
  return StellarSdk.scValToNative(retval) as string[];
}

export async function checkMeterAccess(meterId: string): Promise<boolean> {
  const retval = await client.query("check_access", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
  ]);
  return StellarSdk.scValToNative(retval) as boolean;
}

/** Read the contract-wide emergency pause state for the global banner. */
export async function isContractPaused(): Promise<boolean> {
  const retval = await client.query("is_paused", []);
  return StellarSdk.scValToNative(retval) as boolean;
}

export async function fetchAllMeters(): Promise<MeterData[]> {
  const allMeters: MeterData[] = [];
  const pageSize = 50; // Fetch 50 meters per page to respect Soroban read limits
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      const pageIds = await fetchMetersPaginated(offset, pageSize);
      if (pageIds.length === 0) {
        hasMore = false;
        break;
      }

      // Fetch full meter details for each ID on this page
      const pageMeters = await Promise.all(
        pageIds.map(async (meterId) => {
          try {
            const meter = await fetchMeter(meterId);
            return meter;
          } catch (error) {
            console.warn(`Failed to fetch meter ${meterId}:`, error);
            return null;
          }
        }),
      );

      // Filter out failed fetches and add to results
      const validMeters = pageMeters.filter((m) => m !== null) as MeterData[];
      allMeters.push(...validMeters);

      // Check if we got less than a full page (means we reached the end)
      if (pageIds.length < pageSize) {
        hasMore = false;
      }

      offset += pageSize;
    } catch (error) {
      console.error("Error fetching meters page:", error);
      hasMore = false;
    }
  }

  return allMeters;
}

export async function fetchMetersPaginated(offset: number, limit: number): Promise<string[]> {
  const retval = await client.query("get_all_meters_paginated", [
    StellarSdk.nativeToScVal(offset, { type: "u32" }),
    StellarSdk.nativeToScVal(limit, { type: "u32" }),
  ]);
  return StellarSdk.scValToNative(retval) as string[];
}

export async function transferMeterOwnership(
  sourceAddress: string,
  meterId: string,
  newOwnerAddress: string,
): Promise<string> {
  return contractInvoke(sourceAddress, "transfer_meter_ownership", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    StellarSdk.nativeToScVal(newOwnerAddress, { type: "address" }),
  ]);
}
