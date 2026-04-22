import * as StellarSdk from "@stellar/stellar-sdk";

export const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID ?? "";

const STROOPS_PER_XLM = 10_000_000;
const MILLI_KWH_PER_KWH = 1_000;

const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

/** Read-only contract call (no auth needed). */
export async function contractQuery(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<StellarSdk.xdr.ScVal> {
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const account = await server.getAccount(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", // fee-only source
  );
  const tx = new StellarSdk.TransactionBuilder(account, {
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
  return (sim as any).result?.retval;
}

export interface MeterData {
  active: boolean;
  balance: number; // XLM
  unitsUsed: number; // kWh
  plan: string;
}

/** Fetch and parse a meter from the contract by meter ID symbol. */
export async function fetchMeter(meterId: string): Promise<MeterData> {
  const raw = await contractQuery("get_meter", [
    StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
  ]);
  const native = StellarSdk.scValToNative(raw) as Record<string, unknown>;

  // balance is i128 stroops → XLM; units_used is u64 milli-kWh → kWh
  const balance = Number(native.balance as bigint) / STROOPS_PER_XLM;
  const unitsUsed = Number(native.units_used as bigint) / MILLI_KWH_PER_KWH;

  // PaymentPlan enum comes back as an object key e.g. { Daily: void }
  const planRaw = native.plan as Record<string, unknown>;
  const plan = Object.keys(planRaw)[0] ?? "Unknown";

  return {
    active: native.active as boolean,
    balance: Math.max(0, balance),
    unitsUsed,
    plan,
  };
}

/** Sign and submit a contract transaction via Freighter. */
export async function contractInvoke(
  sourceAddress: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<string> {
  const freighter = (window as any).freighter;
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
  const signed = await freighter.signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  const result = await server.sendTransaction(
    StellarSdk.TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE),
  );
  return result.hash;
}
