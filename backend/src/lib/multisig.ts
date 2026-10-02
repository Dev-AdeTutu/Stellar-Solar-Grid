/**
 * Multi-signature wallet signature collection (#872).
 *
 * Organizational accounts are `multisig_wallet` contracts (a Soroban custom
 * account). When the SolarGrid contract calls `require_auth()` on such a
 * wallet, the network runs the wallet's `__check_auth`, which accepts only
 * N-of-M ed25519 signatures over the authorization payload.
 *
 * This module coordinates collecting those signatures:
 *
 * 1. A proposal simulates the target call to obtain the wallet's
 *    authorization entry (the exact invocation tree plus a nonce), fixes its
 *    expiration ledger and derives the payload every signer must sign —
 *    SHA-256 of the `HashIdPreimage` XDR, which is exactly what SEP-43
 *    `signAuthEntry` signs.
 * 2. Signers submit signatures one by one; each is verified against the
 *    payload and the wallet's on-chain signer set before it is stored, and
 *    signers with an email address are notified of pending approvals.
 * 3. Once the threshold is reached the signatures are attached (sorted by
 *    public key, as `__check_auth` requires) and the transaction is submitted
 *    by the backend relayer, which only pays fees — it cannot authorize
 *    anything on the wallet's behalf.
 */
import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import * as StellarSdk from "@stellar/stellar-sdk";
import { registerDatabase } from "./databaseLifecycle.js";
import { sendEmail } from "./mailer.js";
import { logger } from "./logger.js";

type Db = InstanceType<typeof Database>;

// ── Types ────────────────────────────────────────────────────────────────────

export type WalletSigner = { publicKey: string; email: string | null; label: string | null };

export type MultisigWallet = {
  address: string;
  name: string;
  threshold: number;
  signers: WalletSigner[];
  createdAt: string;
};

export type ProposalStatus = "pending" | "ready" | "submitted" | "failed" | "expired";

export type Proposal = {
  id: string;
  wallet: string;
  contractId: string;
  function: string;
  description: string;
  argsXdr: string[];
  authEntryXdr: string;
  preimageXdr: string;
  payloadHex: string;
  expirationLedger: number;
  threshold: number;
  status: ProposalStatus;
  /** Signer public key (G...) → signature (hex). */
  signatures: Record<string, string>;
  createdBy: string | null;
  createdAt: string;
  submittedAt: string | null;
  txHash: string | null;
  error: string | null;
};

/** Everything that touches the network, injectable for tests. */
export interface MultisigChain {
  networkPassphrase: string;
  /** On-chain signer set (as G... strkeys) and threshold of a wallet contract. */
  getWalletConfig(wallet: string): Promise<{ signers: string[]; threshold: number }>;
  /** Simulate the call and return the wallet's (unsigned) authorization entry. */
  prepareAuthorization(input: {
    wallet: string;
    contractId: string;
    fn: string;
    args: StellarSdk.xdr.ScVal[];
  }): Promise<{ entry: StellarSdk.xdr.SorobanAuthorizationEntry; latestLedger: number }>;
  latestLedger(): Promise<number>;
  /** Submit the call with the signed authorization entry; returns the tx hash. */
  submit(input: {
    contractId: string;
    fn: string;
    args: StellarSdk.xdr.ScVal[];
    auth: StellarSdk.xdr.SorobanAuthorizationEntry[];
  }): Promise<string>;
}

export class MultisigError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Raw 32-byte ed25519 key behind a G... strkey. */
export function signerKeyBytes(publicKey: string): Buffer {
  return Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(publicKey));
}

/** Accept a 64-byte ed25519 signature as hex (SDKs) or base64 (SEP-43 wallets). */
export function decodeSignature(input: string): Buffer {
  const value = input.trim();
  const bytes = /^[0-9a-fA-F]{128}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (bytes.length !== 64) throw new MultisigError(400, "INVALID_SIGNATURE", "signature must be 64 bytes (hex or base64)");
  return bytes;
}

export function verifySignerSignature(publicKey: string, payload: Buffer, signature: Buffer): boolean {
  try {
    return StellarSdk.Keypair.fromPublicKey(publicKey).verify(payload, signature);
  } catch {
    return false;
  }
}

/**
 * Fix the entry's expiration ledger and derive the preimage signers sign.
 * Returns the updated entry, the `HashIdPreimage` XDR and the 32-byte payload.
 */
export function buildAuthPreimage(
  entry: StellarSdk.xdr.SorobanAuthorizationEntry,
  expirationLedger: number,
  networkPassphrase: string,
): { entry: StellarSdk.xdr.SorobanAuthorizationEntry; preimageXdr: string; payload: Buffer } {
  const clone = StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = clone.credentials().address();
  credentials.signatureExpirationLedger(expirationLedger);
  const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new StellarSdk.xdr.HashIdPreimageSorobanAuthorization({
      networkId: StellarSdk.hash(Buffer.from(networkPassphrase)),
      nonce: credentials.nonce(),
      signatureExpirationLedger: expirationLedger,
      invocation: clone.rootInvocation(),
    }),
  );
  const preimageXdr = preimage.toXDR();
  return { entry: clone, preimageXdr: preimageXdr.toString("base64"), payload: StellarSdk.hash(preimageXdr) };
}

/**
 * `Vec<Signature>` for `__check_auth`: `{ public_key, signature }` maps sorted
 * by strictly increasing public key.
 */
export function buildSignatureScVal(signatures: Array<{ publicKey: string; signature: Buffer }>): StellarSdk.xdr.ScVal {
  const sorted = signatures
    .map((s) => ({ key: signerKeyBytes(s.publicKey), signature: s.signature }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  return StellarSdk.xdr.ScVal.scvVec(
    sorted.map((s) =>
      StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol("public_key"), val: StellarSdk.xdr.ScVal.scvBytes(s.key) }),
        new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol("signature"), val: StellarSdk.xdr.ScVal.scvBytes(s.signature) }),
      ]),
    ),
  );
}

// ── Storage ──────────────────────────────────────────────────────────────────

let _db: Db | undefined;

function db(): Db {
  if (!_db) {
    const file = process.env.MULTISIG_DB_PATH ?? path.resolve(process.cwd(), "data", "multisig.sqlite");
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    _db = new Database(file);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS multisig_wallets (
        address TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        signers TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multisig_proposals (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        function TEXT NOT NULL,
        description TEXT NOT NULL,
        args_xdr TEXT NOT NULL,
        auth_entry_xdr TEXT NOT NULL,
        preimage_xdr TEXT NOT NULL,
        payload_hex TEXT NOT NULL,
        expiration_ledger INTEGER NOT NULL,
        threshold INTEGER NOT NULL,
        status TEXT NOT NULL,
        signatures TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        submitted_at TEXT,
        tx_hash TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_msig_proposals_wallet ON multisig_proposals (wallet, created_at);
    `);
    registerDatabase("multisig", () => _db?.close());
  }
  return _db;
}

/** Drop all data (tests only). */
export function resetMultisigForTests(): void {
  db().exec("DELETE FROM multisig_proposals; DELETE FROM multisig_wallets;");
}

type ProposalRow = {
  id: string;
  wallet: string;
  contract_id: string;
  function: string;
  description: string;
  args_xdr: string;
  auth_entry_xdr: string;
  preimage_xdr: string;
  payload_hex: string;
  expiration_ledger: number;
  threshold: number;
  status: ProposalStatus;
  signatures: string;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  tx_hash: string | null;
  error: string | null;
};

function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    wallet: r.wallet,
    contractId: r.contract_id,
    function: r.function,
    description: r.description,
    argsXdr: JSON.parse(r.args_xdr) as string[],
    authEntryXdr: r.auth_entry_xdr,
    preimageXdr: r.preimage_xdr,
    payloadHex: r.payload_hex,
    expirationLedger: r.expiration_ledger,
    threshold: r.threshold,
    status: r.status,
    signatures: JSON.parse(r.signatures) as Record<string, string>,
    createdBy: r.created_by,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    txHash: r.tx_hash,
    error: r.error,
  };
}

function saveProposal(p: Proposal): void {
  db()
    .prepare(
      `INSERT INTO multisig_proposals (id, wallet, contract_id, function, description, args_xdr, auth_entry_xdr,
         preimage_xdr, payload_hex, expiration_ledger, threshold, status, signatures, created_by, created_at,
         submitted_at, tx_hash, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, signatures = excluded.signatures,
         submitted_at = excluded.submitted_at, tx_hash = excluded.tx_hash, error = excluded.error`,
    )
    .run(
      p.id,
      p.wallet,
      p.contractId,
      p.function,
      p.description,
      JSON.stringify(p.argsXdr),
      p.authEntryXdr,
      p.preimageXdr,
      p.payloadHex,
      p.expirationLedger,
      p.threshold,
      p.status,
      JSON.stringify(p.signatures),
      p.createdBy,
      p.createdAt,
      p.submittedAt,
      p.txHash,
      p.error,
    );
}

// ── Wallet registry ──────────────────────────────────────────────────────────

export function getWallet(address: string): MultisigWallet | undefined {
  const row = db().prepare("SELECT * FROM multisig_wallets WHERE address = ?").get(address) as
    | { address: string; name: string; threshold: number; signers: string; created_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    address: row.address,
    name: row.name,
    threshold: row.threshold,
    signers: JSON.parse(row.signers) as WalletSigner[],
    createdAt: row.created_at,
  };
}

/**
 * Register a deployed wallet contract. The signer set and threshold are read
 * from the chain; the caller only supplies display names and notification
 * emails, and every supplied key must be an on-chain signer.
 */
export async function registerWallet(
  chain: MultisigChain,
  input: { address: string; name: string; signers: Array<{ publicKey: string; email?: string; label?: string }> },
): Promise<MultisigWallet> {
  const onChain = await chain.getWalletConfig(input.address);
  const contacts = new Map(input.signers.map((s) => [s.publicKey, s]));
  for (const key of contacts.keys()) {
    if (!onChain.signers.includes(key)) {
      throw new MultisigError(400, "UNKNOWN_SIGNER", `${key} is not a signer of wallet ${input.address}`);
    }
  }
  const wallet: MultisigWallet = {
    address: input.address,
    name: input.name,
    threshold: onChain.threshold,
    signers: onChain.signers.map((publicKey) => ({
      publicKey,
      email: contacts.get(publicKey)?.email ?? null,
      label: contacts.get(publicKey)?.label ?? null,
    })),
    createdAt: new Date().toISOString(),
  };
  db()
    .prepare(
      `INSERT INTO multisig_wallets (address, name, threshold, signers, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET name = excluded.name, threshold = excluded.threshold,
         signers = excluded.signers`,
    )
    .run(wallet.address, wallet.name, wallet.threshold, JSON.stringify(wallet.signers), wallet.createdAt);
  return wallet;
}

// ── Proposals ────────────────────────────────────────────────────────────────

/** Ledgers a proposal stays signable (~1 day at 5s ledgers). */
const SIGNATURE_TTL_LEDGERS = Number(process.env.MULTISIG_SIGNATURE_TTL_LEDGERS ?? 17_280);

export function getProposal(id: string): Proposal | undefined {
  const row = db().prepare("SELECT * FROM multisig_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  return row ? toProposal(row) : undefined;
}

export function listProposals(wallet: string, status?: ProposalStatus): Proposal[] {
  const rows = (
    status
      ? db().prepare("SELECT * FROM multisig_proposals WHERE wallet = ? AND status = ? ORDER BY created_at DESC").all(wallet, status)
      : db().prepare("SELECT * FROM multisig_proposals WHERE wallet = ? ORDER BY created_at DESC").all(wallet)
  ) as ProposalRow[];
  return rows.map(toProposal);
}

function requireWallet(address: string): MultisigWallet {
  const wallet = getWallet(address);
  if (!wallet) throw new MultisigError(404, "WALLET_NOT_FOUND", "Multisig wallet is not registered");
  return wallet;
}

function requireProposal(id: string): Proposal {
  const proposal = getProposal(id);
  if (!proposal) throw new MultisigError(404, "PROPOSAL_NOT_FOUND", "Proposal not found");
  return proposal;
}

export async function createProposal(
  chain: MultisigChain,
  input: { wallet: string; contractId: string; fn: string; args: StellarSdk.xdr.ScVal[]; description: string; createdBy?: string },
): Promise<Proposal> {
  const wallet = requireWallet(input.wallet);
  const { entry, latestLedger } = await chain.prepareAuthorization({
    wallet: input.wallet,
    contractId: input.contractId,
    fn: input.fn,
    args: input.args,
  });
  const expirationLedger = latestLedger + SIGNATURE_TTL_LEDGERS;
  const prepared = buildAuthPreimage(entry, expirationLedger, chain.networkPassphrase);
  const proposal: Proposal = {
    id: crypto.randomUUID(),
    wallet: input.wallet,
    contractId: input.contractId,
    function: input.fn,
    description: input.description,
    argsXdr: input.args.map((a) => a.toXDR("base64")),
    authEntryXdr: prepared.entry.toXDR("base64"),
    preimageXdr: prepared.preimageXdr,
    payloadHex: prepared.payload.toString("hex"),
    expirationLedger,
    threshold: wallet.threshold,
    status: "pending",
    signatures: {},
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
    submittedAt: null,
    txHash: null,
    error: null,
  };
  saveProposal(proposal);
  await notifySigners(wallet, proposal, "pending");
  return proposal;
}

async function refreshExpiry(chain: MultisigChain, proposal: Proposal): Promise<Proposal> {
  if (proposal.status !== "pending" && proposal.status !== "ready") return proposal;
  if ((await chain.latestLedger()) <= proposal.expirationLedger) return proposal;
  const expired = { ...proposal, status: "expired" as const };
  saveProposal(expired);
  return expired;
}

export async function addSignature(
  chain: MultisigChain,
  id: string,
  input: { publicKey: string; signature: string },
): Promise<Proposal> {
  let proposal = await refreshExpiry(chain, requireProposal(id));
  if (proposal.status === "expired") throw new MultisigError(409, "PROPOSAL_EXPIRED", "Proposal has expired");
  if (proposal.status !== "pending" && proposal.status !== "ready") {
    throw new MultisigError(409, "PROPOSAL_CLOSED", `Proposal is ${proposal.status}`);
  }
  const wallet = requireWallet(proposal.wallet);
  if (!wallet.signers.some((s) => s.publicKey === input.publicKey)) {
    throw new MultisigError(403, "NOT_A_SIGNER", "Key is not a signer of this wallet");
  }
  if (proposal.signatures[input.publicKey]) {
    throw new MultisigError(409, "ALREADY_SIGNED", "This signer has already signed");
  }
  const signature = decodeSignature(input.signature);
  if (!verifySignerSignature(input.publicKey, Buffer.from(proposal.payloadHex, "hex"), signature)) {
    throw new MultisigError(400, "INVALID_SIGNATURE", "Signature does not match the proposal payload");
  }

  const signatures = { ...proposal.signatures, [input.publicKey]: signature.toString("hex") };
  const reached = Object.keys(signatures).length >= proposal.threshold;
  proposal = { ...proposal, signatures, status: reached ? "ready" : "pending" };
  saveProposal(proposal);
  if (reached) await notifySigners(wallet, proposal, "ready");
  return proposal;
}

export async function submitProposal(chain: MultisigChain, id: string): Promise<Proposal> {
  let proposal = await refreshExpiry(chain, requireProposal(id));
  if (proposal.status === "expired") throw new MultisigError(409, "PROPOSAL_EXPIRED", "Proposal has expired");
  if (proposal.status !== "ready") {
    throw new MultisigError(409, "NOT_READY", `Proposal is ${proposal.status}; ${proposal.threshold} signatures are required`);
  }
  const entry = StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(proposal.authEntryXdr, "base64");
  entry
    .credentials()
    .address()
    .signature(
      buildSignatureScVal(
        Object.entries(proposal.signatures).map(([publicKey, sig]) => ({ publicKey, signature: Buffer.from(sig, "hex") })),
      ),
    );
  try {
    const txHash = await chain.submit({
      contractId: proposal.contractId,
      fn: proposal.function,
      args: proposal.argsXdr.map((a) => StellarSdk.xdr.ScVal.fromXDR(a, "base64")),
      auth: [entry],
    });
    proposal = { ...proposal, status: "submitted", txHash, submittedAt: new Date().toISOString(), error: null };
  } catch (err) {
    proposal = { ...proposal, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  saveProposal(proposal);
  return proposal;
}

/** Signers (public keys) who still need to sign a proposal. */
export function pendingSigners(wallet: MultisigWallet, proposal: Proposal): string[] {
  return wallet.signers.map((s) => s.publicKey).filter((k) => !proposal.signatures[k]);
}

// ── Notifications ────────────────────────────────────────────────────────────

function proposalUrl(proposal: Proposal): string {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base}/multisig?wallet=${encodeURIComponent(proposal.wallet)}&proposal=${proposal.id}`;
}

async function notifySigners(wallet: MultisigWallet, proposal: Proposal, kind: "pending" | "ready"): Promise<void> {
  const recipients =
    kind === "pending"
      ? wallet.signers.filter((s) => s.email && !proposal.signatures[s.publicKey])
      : wallet.signers.filter((s) => s.email);
  const signed = Object.keys(proposal.signatures).length;
  const subject =
    kind === "pending"
      ? `[${wallet.name}] Signature requested: ${proposal.description}`
      : `[${wallet.name}] Ready to submit: ${proposal.description}`;
  const text =
    kind === "pending"
      ? `A transaction for the multisig wallet "${wallet.name}" needs your approval.\n\n` +
        `Action: ${proposal.description} (${proposal.function})\n` +
        `Approvals: ${signed} of ${proposal.threshold} required\n` +
        `Signable until ledger ${proposal.expirationLedger}\n\n` +
        `Review and sign: ${proposalUrl(proposal)}\n`
      : `The transaction "${proposal.description}" for "${wallet.name}" has ${signed} of ${proposal.threshold} ` +
        `required approvals and can now be submitted.\n\n${proposalUrl(proposal)}\n`;

  await Promise.all(
    recipients.map(async (s) => {
      try {
        await sendEmail({ to: s.email as string, subject, text });
      } catch (err) {
        logger.warn("Multisig notification failed", {
          proposal: proposal.id,
          signer: s.publicKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

// ── Network adapter ──────────────────────────────────────────────────────────

/**
 * Default chain adapter. The relayer (backend admin key) is only the
 * transaction source and fee payer; the wallet's own signatures authorize it.
 */
export function createStellarMultisigChain(options: {
  server: StellarSdk.SorobanRpc.Server;
  relayer: StellarSdk.Keypair;
  networkPassphrase: string;
}): MultisigChain {
  const { server, relayer, networkPassphrase } = options;

  async function buildTx(op: StellarSdk.xdr.Operation) {
    const account = await server.getAccount(relayer.publicKey());
    return new StellarSdk.TransactionBuilder(account, { fee: "100", networkPassphrase })
      .addOperation(op)
      .setTimeout(60)
      .build();
  }

  async function view(contractId: string, fn: string): Promise<StellarSdk.xdr.ScVal> {
    const tx = await buildTx(new StellarSdk.Contract(contractId).call(fn));
    const sim = await server.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    const retval = sim.result?.retval;
    if (!retval) throw new Error(`${fn} returned no value`);
    return retval;
  }

  return {
    networkPassphrase,
    async getWalletConfig(wallet) {
      const [signers, threshold] = await Promise.all([view(wallet, "get_signers"), view(wallet, "get_threshold")]);
      return {
        signers: (StellarSdk.scValToNative(signers) as Uint8Array[]).map((k) =>
          StellarSdk.StrKey.encodeEd25519PublicKey(Buffer.from(k)),
        ),
        threshold: Number(StellarSdk.scValToNative(threshold)),
      };
    },
    async prepareAuthorization({ wallet, contractId, fn, args }) {
      const tx = await buildTx(new StellarSdk.Contract(contractId).call(fn, ...args));
      const sim = await server.simulateTransaction(tx);
      if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) throw new MultisigError(400, "SIMULATION_FAILED", sim.error);
      const entry = (sim.result?.auth ?? []).find((e) => {
        if (e.credentials().switch() !== StellarSdk.xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return false;
        return StellarSdk.Address.fromScAddress(e.credentials().address().address()).toString() === wallet;
      });
      if (!entry) throw new MultisigError(400, "WALLET_AUTH_NOT_REQUIRED", "The call does not require the wallet's authorization");
      return { entry, latestLedger: sim.latestLedger };
    },
    async latestLedger() {
      return (await server.getLatestLedger()).sequence;
    },
    async submit({ contractId, fn, args, auth }) {
      const tx = await buildTx(StellarSdk.Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth }));
      const prepared = await server.prepareTransaction(tx);
      prepared.sign(relayer);
      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") throw new Error(`Transaction rejected: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`);
      for (let i = 0; i < 15; i++) {
        const status = await server.getTransaction(sent.hash);
        if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
        if (status.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED) {
          throw new Error(`Transaction failed: ${sent.hash}`);
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(`Transaction not confirmed: ${sent.hash}`);
    },
  };
}
