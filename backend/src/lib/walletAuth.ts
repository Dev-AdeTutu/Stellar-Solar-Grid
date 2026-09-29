/**
 * Wallet-signature authentication (SEP-10 style) used by smart-home account
 * linking and self-service privacy controls (#904).
 *
 * 1. createChallenge(address) returns an unsubmittable transaction (sequence
 *    0, manageData "solargrid_auth" = random nonce, 5 minute time bounds)
 *    with the user's account as the source.
 * 2. The user signs it with their wallet (Freighter / xBull) — nothing is
 *    submitted to the network.
 * 3. verifyChallenge(address, signedXdr) checks the nonce is ours, unexpired
 *    and unused, and that the signature was produced by `address`.
 * 4. A short-lived opaque session token is then issued for follow-up calls.
 */
import crypto from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = Number(process.env.WALLET_SESSION_TTL_MS ?? 60 * 60 * 1000);
const DATA_KEY = "solargrid_auth";

function networkPassphrase(): string {
  return process.env.STELLAR_NETWORK === "mainnet" ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;
}

const challenges = new Map<string, { address: string; expiresAt: number }>();
const sessions = new Map<string, { address: string; expiresAt: number }>();

function prune(map: Map<string, { expiresAt: number }>, now = Date.now()) {
  for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
}

export function createChallenge(address: string): { transaction: string; networkPassphrase: string; expiresAt: string } {
  StellarSdk.Keypair.fromPublicKey(address); // throws on malformed input
  prune(challenges);
  const nonce = crypto.randomBytes(24).toString("base64"); // 32 chars ≤ 64-byte manageData limit
  const now = Math.floor(Date.now() / 1000);
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(address, "-1"), {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: networkPassphrase(),
    timebounds: { minTime: now, maxTime: now + CHALLENGE_TTL_MS / 1000 },
  })
    .addOperation(StellarSdk.Operation.manageData({ name: DATA_KEY, value: nonce }))
    .build();
  challenges.set(nonce, { address, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return {
    transaction: tx.toXDR(),
    networkPassphrase: networkPassphrase(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  };
}

/** Returns true if `signedXdr` is our challenge for `address`, signed by `address`. Single use. */
export function verifyChallenge(address: string, signedXdr: string): boolean {
  let tx: StellarSdk.Transaction;
  try {
    const parsed = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
    if (!(parsed instanceof StellarSdk.Transaction)) return false;
    tx = parsed;
  } catch {
    return false;
  }
  if (tx.source !== address || tx.sequence !== "0" || tx.operations.length !== 1) return false;
  const op = tx.operations[0];
  if (op.type !== "manageData" || op.name !== DATA_KEY || !op.value) return false;

  const nonce = op.value.toString();
  const pending = challenges.get(nonce);
  if (!pending || pending.address !== address || pending.expiresAt <= Date.now()) return false;

  const keypair = StellarSdk.Keypair.fromPublicKey(address);
  const hash = tx.hash();
  const signed = tx.signatures.some((sig) => {
    try {
      return keypair.verify(hash, sig.signature());
    } catch {
      return false;
    }
  });
  if (signed) challenges.delete(nonce);
  return signed;
}

export function createSession(address: string): { token: string; expiresAt: string } {
  prune(sessions);
  const token = `sgs_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { address, expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function sessionAddress(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const s = sessions.get(token);
  if (!s || s.expiresAt <= Date.now()) return undefined;
  return s.address;
}

export function endSession(token: string): void {
  sessions.delete(token);
}
