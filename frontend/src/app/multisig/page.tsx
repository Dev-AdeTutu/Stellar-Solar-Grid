"use client";

/**
 * Organizational multi-signature wallets (#872): pending approvals, signing
 * with the connected wallet, submission once the threshold is met, and new
 * proposals.
 */
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import {
  canSign,
  createProposal,
  fetchProposals,
  fetchWallet,
  sortProposals,
  submitProposal,
  submitSignature,
  type MultisigProposal,
  type MultisigWallet,
  type ProposalAction,
} from "@/lib/multisig";

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const STATUS_STYLES: Record<MultisigProposal["status"], string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  ready: "bg-sky-500/20 text-sky-300",
  submitted: "bg-green-500/20 text-green-400",
  failed: "bg-red-500/20 text-red-400",
  expired: "bg-gray-500/20 text-gray-300",
};

const STATUS_LABELS: Record<MultisigProposal["status"], string> = {
  pending: "Awaiting approvals",
  ready: "Ready to submit",
  submitted: "Submitted",
  failed: "Failed",
  expired: "Expired",
};

function ProposalCard({
  proposal,
  wallet,
  address,
  highlighted,
  onChange,
}: {
  proposal: MultisigProposal;
  wallet: MultisigWallet;
  address: string | null;
  highlighted: boolean;
  onChange: (p: MultisigProposal) => void;
}) {
  const signAuthEntry = useWalletStore((s) => s.signAuthEntry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvals = proposal.signedBy.length;
  const label = (key: string) => wallet.signers.find((s) => s.publicKey === key)?.label ?? short(key);

  async function run(action: () => Promise<MultisigProposal>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      id={`proposal-${proposal.id}`}
      className={`rounded-lg border p-4 ${highlighted ? "border-solar-yellow" : "border-white/10"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{proposal.description}</h3>
          <p className="text-xs opacity-60">
            {proposal.function} · proposed {new Date(proposal.createdAt).toLocaleString()}
            {proposal.createdBy ? ` by ${label(proposal.createdBy)}` : ""}
          </p>
        </div>
        <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[proposal.status]}`}>
          {STATUS_LABELS[proposal.status]}
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex justify-between text-sm">
          <span>Approvals</span>
          <span>
            {approvals} of {proposal.threshold}
          </span>
        </div>
        <div
          className="h-2 overflow-hidden rounded bg-white/10"
          role="progressbar"
          aria-label="Approvals"
          aria-valuemin={0}
          aria-valuemax={proposal.threshold}
          aria-valuenow={approvals}
        >
          <div
            className="h-full bg-solar-yellow"
            style={{ width: `${Math.min(100, (approvals / proposal.threshold) * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs opacity-70">
          Signed: {proposal.signedBy.length ? proposal.signedBy.map(label).join(", ") : "nobody yet"}
          {proposal.pendingSigners.length > 0 && ` · Waiting on: ${proposal.pendingSigners.map(label).join(", ")}`}
        </p>
      </div>

      {proposal.txHash && <p className="mt-2 break-all text-xs">Transaction: {proposal.txHash}</p>}
      {proposal.error && <p className="mt-2 text-xs text-red-400">Error: {proposal.error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {canSign(proposal, address) && (
          <button
            type="button"
            disabled={busy}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            onClick={() =>
              run(async () => submitSignature(proposal.id, address as string, await signAuthEntry(proposal.preimageXdr)))
            }
          >
            Approve with wallet
          </button>
        )}
        {proposal.status === "ready" && (
          <button
            type="button"
            disabled={busy}
            className="rounded bg-green-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            onClick={() => run(() => submitProposal(proposal.id))}
          >
            Submit transaction
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </li>
  );
}

function NewProposalForm({ wallet, address, onCreated }: { wallet: MultisigWallet; address: string | null; onCreated: () => void }) {
  const [action, setAction] = useState<ProposalAction["action"]>("make_payment");
  const [meterId, setMeterId] = useState("");
  const [amount, setAmount] = useState("");
  const [plan, setPlan] = useState("Monthly");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function build(): ProposalAction {
    switch (action) {
      case "make_payment":
        return { action, params: { meterId, amount, plan } };
      case "transfer_meter":
        return { action, params: { meterId, newOwner: target } };
      case "set_emergency_contact":
        return { action, params: { meterId, contact: target || null } };
      default:
        return { action, params: { meterId, delegate: target } };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const signer = wallet.signers.some((s) => s.publicKey === address) ? (address as string) : undefined;
      await createProposal(wallet.address, build(), signer);
      setMeterId("");
      setAmount("");
      setTarget("");
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const targetLabel =
    action === "transfer_meter" ? "New owner" : action === "set_emergency_contact" ? "Contact (blank to clear)" : "Delegate";

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-2 rounded-lg border border-white/10 p-4" aria-labelledby="new-proposal">
      <h2 id="new-proposal" className="font-semibold">New proposal</h2>
      <label className="block text-sm">
        Action
        <select
          className="mt-1 block w-full rounded border bg-transparent px-3 py-2"
          value={action}
          onChange={(e) => setAction(e.target.value as ProposalAction["action"])}
        >
          <option value="make_payment">Pay for a meter</option>
          <option value="transfer_meter">Transfer a meter</option>
          <option value="set_emergency_contact">Set emergency contact</option>
          <option value="add_delegate">Add payment delegate</option>
          <option value="remove_delegate">Remove payment delegate</option>
        </select>
      </label>
      <label className="block text-sm">
        Meter ID
        <input className="mt-1 block w-full rounded border bg-transparent px-3 py-2" value={meterId} onChange={(e) => setMeterId(e.target.value)} required />
      </label>
      {action === "make_payment" ? (
        <div className="flex gap-2">
          <label className="block flex-1 text-sm">
            Amount (stroops)
            <input
              className="mt-1 block w-full rounded border bg-transparent px-3 py-2"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm">
            Plan
            <select className="mt-1 block rounded border bg-transparent px-3 py-2" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {["Daily", "Weekly", "Monthly", "UsageBased"].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <label className="block text-sm">
          {targetLabel}
          <input
            className="mt-1 block w-full rounded border bg-transparent px-3 py-2"
            placeholder="G… or C…"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required={action !== "set_emergency_contact"}
          />
        </label>
      )}
      <button type="submit" disabled={busy} className="rounded bg-sky-600 px-4 py-2 text-white disabled:opacity-50">
        {busy ? "Creating…" : "Create proposal"}
      </button>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <p className="text-xs opacity-60">
        Every signer with an email on file is notified. The action executes only after {wallet.threshold} of{" "}
        {wallet.signers.length} signers approve.
      </p>
    </form>
  );
}

export default function MultisigPage() {
  const address = useWalletStore((s) => s.address);
  const [input, setInput] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [wallet, setWallet] = useState<MultisigWallet | null>(null);
  const [proposals, setProposals] = useState<MultisigProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("wallet");
    if (fromUrl) {
      setInput(fromUrl);
      setWalletAddress(fromUrl);
    }
    setHighlight(params.get("proposal"));
  }, []);

  const load = useCallback(async (addr: string) => {
    setLoading(true);
    setError(null);
    try {
      const [w, p] = await Promise.all([fetchWallet(addr), fetchProposals(addr)]);
      setWallet(w);
      setProposals(sortProposals(p));
    } catch (e) {
      setWallet(null);
      setProposals([]);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (walletAddress) void load(walletAddress);
  }, [walletAddress, load]);

  const replace = (updated: MultisigProposal) =>
    setProposals((list) => sortProposals(list.map((p) => (p.id === updated.id ? updated : p))));

  const open = proposals.filter((p) => p.status === "pending" || p.status === "ready");
  const closed = proposals.filter((p) => p.status !== "pending" && p.status !== "ready");
  const isSigner = !!wallet && !!address && wallet.signers.some((s) => s.publicKey === address);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Organization wallets</h1>
        <p className="mb-6 text-sm opacity-70">
          Multi-signature wallets require approval from several members before a payment or meter change is executed.
        </p>

        <form
          className="mb-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setWalletAddress(input.trim());
          }}
        >
          <label htmlFor="msig-wallet" className="sr-only">Wallet address</label>
          <input
            id="msig-wallet"
            className="flex-1 rounded border bg-transparent px-3 py-2"
            placeholder="Wallet contract address (C…)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" disabled={!input.trim()} className="rounded bg-sky-600 px-4 py-2 text-white disabled:opacity-50">
            Open
          </button>
        </form>

        {loading && <p>Loading…</p>}
        {error && <p className="text-red-500">Failed to load wallet: {error}</p>}

        {wallet && !loading && (
          <>
            <section className="mb-6 rounded-lg border border-white/10 p-4" aria-labelledby="wallet-heading">
              <h2 id="wallet-heading" className="text-lg font-semibold">{wallet.name}</h2>
              <p className="break-all text-xs opacity-60">{wallet.address}</p>
              <p className="mt-2 text-sm">
                Requires <strong>{wallet.threshold}</strong> of <strong>{wallet.signers.length}</strong> signatures.
                {!address && " Connect a signer's wallet to approve."}
                {address && !isSigner && " The connected account is not a signer of this wallet."}
              </p>
              <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                {wallet.signers.map((s) => (
                  <li key={s.publicKey} className="rounded bg-white/5 px-2 py-1" title={s.publicKey}>
                    {s.label ?? short(s.publicKey)}
                    {s.publicKey === address && " (you)"}
                  </li>
                ))}
              </ul>
            </section>

            <h2 className="mb-2 font-semibold">Pending approvals ({open.length})</h2>
            {open.length === 0 ? (
              <p className="text-sm opacity-70">Nothing is waiting for approval.</p>
            ) : (
              <ul className="space-y-3">
                {open.map((p) => (
                  <ProposalCard key={p.id} proposal={p} wallet={wallet} address={address} highlighted={p.id === highlight} onChange={replace} />
                ))}
              </ul>
            )}

            {closed.length > 0 && (
              <>
                <h2 className="mb-2 mt-8 font-semibold">History</h2>
                <ul className="space-y-3">
                  {closed.map((p) => (
                    <ProposalCard key={p.id} proposal={p} wallet={wallet} address={address} highlighted={p.id === highlight} onChange={replace} />
                  ))}
                </ul>
              </>
            )}

            <NewProposalForm wallet={wallet} address={address} onCreated={() => void load(wallet.address)} />
          </>
        )}
      </main>
    </>
  );
}
