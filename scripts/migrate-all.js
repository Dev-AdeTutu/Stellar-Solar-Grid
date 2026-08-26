#!/usr/bin/env node
/**
 * scripts/migrate-all.js
 *
 * Bulk migration helper — closes #536.
 *
 * Fetches every registered meter via `get_all_meters` and calls
 * `migrate_meter(meter_id)` for each one, logging per-meter success/failure
 * and printing a summary at the end.
 *
 * Usage (via Makefile):
 *   make migrate-all CONTRACT_ID=C... ADMIN_SECRET_KEY=S... [NETWORK=testnet]
 *
 * Usage (directly):
 *   node scripts/migrate-all.js
 *
 * Required environment variables:
 *   CONTRACT_ID        — Soroban contract address
 *   ADMIN_SECRET_KEY   — Admin Stellar secret key (S...)
 *
 * Optional environment variables:
 *   STELLAR_NETWORK    — "testnet" (default) or "mainnet"
 *   STELLAR_RPC_URL    — Override the default RPC endpoint
 *   DRY_RUN            — Set to "true" to list meters without migrating
 *
 * Exit codes:
 *   0 — all meters migrated successfully (or DRY_RUN)
 *   1 — one or more meters failed to migrate
 */

import * as StellarSdk from "@stellar/stellar-sdk";

// ── Config ───────────────────────────────────────────────────────────────────

const CONTRACT_ID = process.env.CONTRACT_ID;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const DRY_RUN = process.env.DRY_RUN === "true";

const NETWORK_PASSPHRASE =
  NETWORK === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

const RPC_URL =
  process.env.STELLAR_RPC_URL ??
  (NETWORK === "mainnet"
    ? "https://soroban-rpc.stellar.org"
    : "https://soroban-testnet.stellar.org");

// ── Validation ───────────────────────────────────────────────────────────────

if (!CONTRACT_ID) {
  console.error("ERROR: CONTRACT_ID environment variable is required.");
  console.error(
    "  Usage: CONTRACT_ID=C... ADMIN_SECRET_KEY=S... node scripts/migrate-all.js",
  );
  process.exit(1);
}

if (!ADMIN_SECRET_KEY) {
  console.error("ERROR: ADMIN_SECRET_KEY environment variable is required.");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const rpcServer = new StellarSdk.SorobanRpc.Server(RPC_URL);
const adminKeypair = StellarSdk.Keypair.fromSecret(ADMIN_SECRET_KEY);
const contract = new StellarSdk.Contract(CONTRACT_ID);

/** Redact admin secret from any string before printing. */
const scrub = (msg) => String(msg ?? "").replaceAll(ADMIN_SECRET_KEY, "[REDACTED]");

/**
 * Poll until transaction reaches SUCCESS or FAILED.
 */
async function waitForTx(hash, maxAttempts = 15, intervalMs = 2_000) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await rpcServer.getTransaction(hash);
    if (
      result.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS
    ) {
      return;
    }
    if (
      result.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED
    ) {
      throw new Error(`Transaction ${hash} failed on-chain.`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Transaction ${hash} timed out after ${maxAttempts} polls.`);
}

/**
 * Invoke a contract function and wait for confirmation.
 */
async function invokeContract(method, args = []) {
  const account = await rpcServer.getAccount(adminKeypair.publicKey());

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(scrub(String(sim.error ?? sim)));
  }

  tx = StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
  tx.sign(adminKeypair);

  const sendResult = await rpcServer.sendTransaction(tx);
  await waitForTx(sendResult.hash);
  return sendResult.hash;
}

/**
 * Query a contract function (simulation only, no on-chain transaction).
 */
async function queryContract(method, args = []) {
  const account = await rpcServer.getAccount(adminKeypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(scrub(String(sim.error ?? sim)));
  }

  return sim.result?.retval;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("SolarGrid bulk meter migration");
  console.log(`  Network  : ${NETWORK}`);
  console.log(`  RPC URL  : ${RPC_URL}`);
  console.log(`  Contract : ${CONTRACT_ID}`);
  console.log(`  Admin    : ${adminKeypair.publicKey()}`);
  if (DRY_RUN) console.log("  DRY RUN  : true — no transactions will be sent");
  console.log("=".repeat(60));

  // 1. Fetch all registered meters.
  console.log("\n[1/3] Fetching all registered meters via get_all_meters...");
  let meters;
  try {
    const result = await queryContract("get_all_meters");
    meters = StellarSdk.scValToNative(result) ?? [];
  } catch (err) {
    console.error("ERROR: Failed to fetch meters:", scrub(err?.message));
    process.exit(1);
  }

  if (!Array.isArray(meters) || meters.length === 0) {
    console.log("No meters found. Nothing to migrate.");
    process.exit(0);
  }

  // Extract meter IDs from the contract's return value.
  // The contract returns an array of Meter structs; meter_id is a String field.
  const meterIds = meters.map((m) => {
    // Handle both { meter_id: "..." } structs and raw string arrays.
    if (typeof m === "string") return m;
    if (m && typeof m.meter_id === "string") return m.meter_id;
    if (m && typeof m.id === "string") return m.id;
    return String(m);
  });

  console.log(`Found ${meterIds.length} meter(s):`);
  meterIds.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));

  if (DRY_RUN) {
    console.log("\nDRY_RUN=true — skipping migration transactions.");
    process.exit(0);
  }

  // 2. Migrate each meter.
  console.log(`\n[2/3] Migrating ${meterIds.length} meter(s)...`);

  const results = { success: [], failed: [] };

  for (const meterId of meterIds) {
    process.stdout.write(`  migrate_meter(${meterId}) ... `);
    try {
      const hash = await invokeContract("migrate_meter", [
        StellarSdk.nativeToScVal(meterId, { type: "string" }),
      ]);
      console.log(`OK  (tx: ${hash})`);
      results.success.push(meterId);
    } catch (err) {
      console.log(`FAILED`);
      console.error(`    Error: ${scrub(err?.message)}`);
      results.failed.push({ meterId, error: scrub(err?.message) });
    }
  }

  // 3. Print summary.
  console.log("\n[3/3] Migration summary");
  console.log("=".repeat(60));
  console.log(
    `  Total   : ${meterIds.length}`,
  );
  console.log(`  Success : ${results.success.length}`);
  console.log(`  Failed  : ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log("\nFailed meters:");
    results.failed.forEach(({ meterId, error }) => {
      console.log(`  - ${meterId}: ${error}`);
    });
    console.log(
      "\nRe-run this script to retry failed meters (migrate_meter is idempotent).",
    );
    process.exit(1);
  }

  console.log("\nAll meters migrated successfully.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", scrub(err?.message ?? err));
  process.exit(1);
});
