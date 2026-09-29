/**
 * Client for the multi-signature wallet API (#872).
 */
import { env } from "@/lib/env";

export type MultisigWallet = {
  address: string;
  name: string;
  threshold: number;
  signers: Array<{ publicKey: string; label: string | null; notifications: boolean }>;
  createdAt: string;
};

export type ProposalStatus = "pending" | "ready" | "submitted" | "failed" | "expired";

export type MultisigProposal = {
  id: string;
  wallet: string;
  function: string;
  description: string;
  preimageXdr: string;
  payloadHex: string;
  expirationLedger: number;
  threshold: number;
  status: ProposalStatus;
  signedBy: string[];
  pendingSigners: string[];
  createdBy: string | null;
  createdAt: string;
  txHash: string | null;
  error: string | null;
};

export type ProposalAction =
  | { action: "make_payment"; params: { meterId: string; amount: string; plan: string } }
  | { action: "transfer_meter"; params: { meterId: string; newOwner: string } }
  | { action: "set_emergency_contact"; params: { meterId: string; contact: string | null } }
  | { action: "add_delegate" | "remove_delegate"; params: { meterId: string; delegate: string } };

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/multisig`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !(res.status === 502 && "proposal" in body)) {
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return body;
}

export async function fetchWallet(address: string): Promise<MultisigWallet> {
  return (await request<{ wallet: MultisigWallet }>(`${API}/wallets/${encodeURIComponent(address)}`)).wallet;
}

export async function fetchProposals(address: string): Promise<MultisigProposal[]> {
  return (await request<{ proposals: MultisigProposal[] }>(`${API}/wallets/${encodeURIComponent(address)}/proposals`))
    .proposals;
}

export async function createProposal(wallet: string, action: ProposalAction, proposer?: string): Promise<MultisigProposal> {
  const res = await request<{ proposal: MultisigProposal }>(`${API}/wallets/${encodeURIComponent(wallet)}/proposals`, {
    method: "POST",
    body: JSON.stringify({ ...action, proposer }),
  });
  return res.proposal;
}

export async function submitSignature(id: string, publicKey: string, signature: string): Promise<MultisigProposal> {
  const res = await request<{ proposal: MultisigProposal }>(`${API}/proposals/${encodeURIComponent(id)}/signatures`, {
    method: "POST",
    body: JSON.stringify({ publicKey, signature }),
  });
  return res.proposal;
}

export async function submitProposal(id: string): Promise<MultisigProposal> {
  const res = await request<{ proposal: MultisigProposal }>(`${API}/proposals/${encodeURIComponent(id)}/submit`, {
    method: "POST",
  });
  return res.proposal;
}

/** Proposals that still need action first, newest first within each group. */
export function sortProposals(proposals: MultisigProposal[]): MultisigProposal[] {
  const rank: Record<ProposalStatus, number> = { ready: 0, pending: 1, failed: 2, submitted: 3, expired: 4 };
  return [...proposals].sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt));
}

/** Whether `address` can still add a signature to `proposal`. */
export function canSign(proposal: MultisigProposal, address: string | null): boolean {
  return (
    !!address &&
    (proposal.status === "pending" || proposal.status === "ready") &&
    proposal.pendingSigners.includes(address)
  );
}
