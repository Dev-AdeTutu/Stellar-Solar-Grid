import * as StellarSdk from "@stellar/stellar-sdk";

const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
export const NETWORK_PASSPHRASE =
  NETWORK === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

export const RPC_URL =
  NETWORK === "mainnet"
    ? "https://soroban-rpc.stellar.org"
    : "https://soroban-testnet.stellar.org";

export const CONTRACT_ID = process.env.CONTRACT_ID!;
export const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

/** Submit a signed contract invocation from the admin keypair. */
export async function adminInvoke(
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const adminKeypair = StellarSdk.Keypair.fromSecret(
    process.env.ADMIN_SECRET_KEY!
  );
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

  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction submission failed: ${sendResult.errorResult}`);
  }

  // Poll until SUCCESS or FAILED (fixes #30)
  const hash = sendResult.hash;
  const timeoutMs = Number(process.env.TX_TIMEOUT_MS ?? 30_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_500));
    const status = await server.getTransaction(hash);
    if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${hash} failed on-chain`);
    }
    // NOT_FOUND means still pending — keep polling
  }

  throw new Error(`Transaction ${hash} not confirmed within ${timeoutMs}ms`);
}

/** Read-only simulation. */
export async function contractQuery(
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<StellarSdk.xdr.ScVal> {
  const adminKeypair = StellarSdk.Keypair.fromSecret(
    process.env.ADMIN_SECRET_KEY!
  );
  const account = await server.getAccount(adminKeypair.publicKey());
  const contract = new StellarSdk.Contract(CONTRACT_ID);

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
