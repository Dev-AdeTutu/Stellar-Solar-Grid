/**
 * Multi-signature wallet API (#872).
 *
 *   POST /api/multisig/wallets                          register a deployed wallet (admin)
 *   GET  /api/multisig/wallets/:address                 wallet, signers and threshold
 *   GET  /api/multisig/wallets/:address/proposals       proposals (?status=pending)
 *   POST /api/multisig/wallets/:address/proposals       propose a SolarGrid action
 *   GET  /api/multisig/proposals/:id                    proposal incl. payload to sign
 *   POST /api/multisig/proposals/:id/signatures         add one signer's signature
 *   POST /api/multisig/proposals/:id/submit             submit once the threshold is met
 *
 * Proposals are built from a fixed catalog of SolarGrid actions that need the
 * wallet's authorization, so clients never send raw XDR.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  MultisigError,
  addSignature,
  createProposal,
  getProposal,
  getWallet,
  listProposals,
  pendingSigners,
  registerWallet,
  submitProposal,
  type MultisigChain,
  type MultisigWallet,
  type Proposal,
} from "../lib/multisig.js";

const isAccount = (v: string) => StellarSdk.StrKey.isValidEd25519PublicKey(v);
const isContract = (v: string) => StellarSdk.StrKey.isValidContract(v);
const isAddress = (v: string) => isAccount(v) || isContract(v);

const address = (v: string) => StellarSdk.nativeToScVal(v, { type: "address" });
const str = (v: string) => StellarSdk.nativeToScVal(v, { type: "string" });
const i128 = (v: string) => StellarSdk.nativeToScVal(BigInt(v), { type: "i128" });
const unitEnum = (variant: string) => StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(variant)]);
const none = () => StellarSdk.xdr.ScVal.scvVoid();

const MeterId = z.string().min(1).max(64);
const Amount = z.string().regex(/^[1-9][0-9]{0,37}$/, "amount must be a positive integer (stroops)");
const Addr = z.string().refine(isAddress, "must be a Stellar address");

/** SolarGrid actions a wallet-owned meter can take, mapped to contract args. */
const ACTIONS = {
  make_payment: {
    schema: z.object({
      meterId: MeterId,
      amount: Amount,
      plan: z.enum(["Daily", "Weekly", "Monthly", "UsageBased"]),
      memo: z.string().max(100).optional(),
    }),
    describe: (p: { meterId: string; amount: string; plan: string }) => `Pay ${p.amount} stroops (${p.plan}) for meter ${p.meterId}`,
    args: (wallet: string, p: { meterId: string; amount: string; plan: string; memo?: string }) => [
      str(p.meterId),
      address(wallet),
      i128(p.amount),
      unitEnum(p.plan),
      p.memo ? str(p.memo) : none(),
    ],
  },
  transfer_meter: {
    schema: z.object({ meterId: MeterId, newOwner: Addr }),
    describe: (p: { meterId: string; newOwner: string }) => `Transfer meter ${p.meterId} to ${p.newOwner}`,
    args: (_wallet: string, p: { meterId: string; newOwner: string }) => [str(p.meterId), address(p.newOwner)],
  },
  set_emergency_contact: {
    schema: z.object({ meterId: MeterId, contact: Addr.nullable() }),
    describe: (p: { meterId: string; contact: string | null }) =>
      p.contact ? `Set emergency contact of ${p.meterId} to ${p.contact}` : `Clear emergency contact of ${p.meterId}`,
    args: (_wallet: string, p: { meterId: string; contact: string | null }) => [
      str(p.meterId),
      p.contact ? address(p.contact) : none(),
    ],
  },
  add_delegate: {
    schema: z.object({ meterId: MeterId, delegate: Addr }),
    describe: (p: { meterId: string; delegate: string }) => `Allow ${p.delegate} to pay for meter ${p.meterId}`,
    args: (_wallet: string, p: { meterId: string; delegate: string }) => [str(p.meterId), address(p.delegate)],
  },
  remove_delegate: {
    schema: z.object({ meterId: MeterId, delegate: Addr }),
    describe: (p: { meterId: string; delegate: string }) => `Revoke ${p.delegate} as payer for meter ${p.meterId}`,
    args: (_wallet: string, p: { meterId: string; delegate: string }) => [str(p.meterId), address(p.delegate)],
  },
} as const;

type ActionName = keyof typeof ACTIONS;

const RegisterSchema = z.object({
  address: z.string().refine(isContract, "wallet address must be a contract (C...) address"),
  name: z.string().min(1).max(80),
  signers: z
    .array(
      z.object({
        publicKey: z.string().refine(isAccount, "publicKey must be a G... account"),
        email: z.string().email().optional(),
        label: z.string().max(80).optional(),
      }),
    )
    .max(20)
    .default([]),
});

const ProposalSchema = z.object({
  action: z.enum(Object.keys(ACTIONS) as [ActionName, ...ActionName[]]),
  params: z.record(z.string(), z.unknown()),
  proposer: z.string().refine(isAccount).optional(),
});

const SignatureSchema = z.object({
  publicKey: z.string().refine(isAccount, "publicKey must be a G... account"),
  signature: z.string().min(1),
});

/** Public view: signer emails are never returned. */
function publicWallet(wallet: MultisigWallet) {
  return {
    address: wallet.address,
    name: wallet.name,
    threshold: wallet.threshold,
    signers: wallet.signers.map((s) => ({ publicKey: s.publicKey, label: s.label, notifications: Boolean(s.email) })),
    createdAt: wallet.createdAt,
  };
}

function publicProposal(proposal: Proposal) {
  const wallet = getWallet(proposal.wallet);
  return {
    ...proposal,
    signedBy: Object.keys(proposal.signatures),
    pendingSigners: wallet ? pendingSigners(wallet, proposal) : [],
  };
}

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR", details: error.flatten() });
}

export function createMultisigRouter(chain: MultisigChain, contractId: string): Router {
  const router = Router();

  router.post(
    "/wallets",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const wallet = await registerWallet(chain, parsed.data);
      return res.status(201).json({ wallet: publicWallet(wallet) });
    }),
  );

  router.get("/wallets/:address", (req, res) => {
    const wallet = getWallet(String(req.params.address));
    if (!wallet) return res.status(404).json({ error: "Multisig wallet is not registered", code: "WALLET_NOT_FOUND" });
    return res.json({ wallet: publicWallet(wallet) });
  });

  router.get("/wallets/:address/proposals", (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !["pending", "ready", "submitted", "failed", "expired"].includes(status)) {
      return res.status(400).json({ error: "Unknown status filter", code: "VALIDATION_ERROR" });
    }
    const proposals = listProposals(String(req.params.address), status as Proposal["status"] | undefined);
    return res.json({ proposals: proposals.map(publicProposal) });
  });

  router.post(
    "/wallets/:address/proposals",
    asyncHandler(async (req, res) => {
      const parsed = ProposalSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const walletAddress = String(req.params.address);
      const wallet = getWallet(walletAddress);
      if (!wallet) return res.status(404).json({ error: "Multisig wallet is not registered", code: "WALLET_NOT_FOUND" });
      if (parsed.data.proposer && !wallet.signers.some((s) => s.publicKey === parsed.data.proposer)) {
        return res.status(403).json({ error: "Only wallet signers can propose", code: "NOT_A_SIGNER" });
      }

      const action = ACTIONS[parsed.data.action];
      const params = action.schema.safeParse(parsed.data.params);
      if (!params.success) return validationError(res, params.error);
      // Each schema matches its own describe/args signature.
      const p = params.data as never;
      const proposal = await createProposal(chain, {
        wallet: walletAddress,
        contractId,
        fn: parsed.data.action,
        args: action.args(walletAddress, p),
        description: action.describe(p),
        createdBy: parsed.data.proposer,
      });
      return res.status(201).json({ proposal: publicProposal(proposal) });
    }),
  );

  router.get("/proposals/:id", (req, res) => {
    const proposal = getProposal(String(req.params.id));
    if (!proposal) return res.status(404).json({ error: "Proposal not found", code: "PROPOSAL_NOT_FOUND" });
    return res.json({ proposal: publicProposal(proposal) });
  });

  router.post(
    "/proposals/:id/signatures",
    asyncHandler(async (req, res) => {
      const parsed = SignatureSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const proposal = await addSignature(chain, String(req.params.id), parsed.data);
      return res.json({ proposal: publicProposal(proposal) });
    }),
  );

  router.post(
    "/proposals/:id/submit",
    asyncHandler(async (req, res) => {
      const proposal = await submitProposal(chain, String(req.params.id));
      return res.status(proposal.status === "submitted" ? 200 : 502).json({ proposal: publicProposal(proposal) });
    }),
  );

  // Map domain errors to HTTP responses; anything else goes to the app handler.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MultisigError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  });

  return router;
}
