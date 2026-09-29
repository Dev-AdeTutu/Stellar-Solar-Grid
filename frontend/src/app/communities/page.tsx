"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";
import { getSmartHomeSession } from "@/lib/smartHomeClient";
import { useWalletStore } from "@/store/walletStore";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const INPUT = "min-w-0 rounded border border-white/15 bg-transparent px-3 py-2 text-sm";
const BUTTON = "rounded border border-white/20 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40";

type Community = {
  id: string;
  name: string;
  description: string;
  ownerAddress: string;
  discountPercent: number;
  pooledKwh: number;
  contributedKwh: number;
  allocatedKwh: number;
  discountedEnergyKwh?: number;
  memberCount: number;
  isMember: boolean;
};

type Member = { address: string; role: string; joinedAt: string };
type EnergyTransaction = {
  memberAddress: string;
  type: "contribution" | "allocation";
  kwh: number;
  discountPercent: number;
  createdAt: string;
};
type Proposal = {
  id: string;
  title: string;
  description: string;
  discountPercent: number;
  status: "open" | "passed" | "rejected";
  endsAt: string;
  yesVotes: number;
  noVotes: number;
  eligibleVoters: number;
  myVote: "yes" | "no" | null;
};
type Dashboard = Community & { members: Member[]; energyTransactions: EnergyTransaction[]; proposals: Proposal[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export default function CommunitiesPage() {
  const address = useWalletStore((state) => state.address);
  const signTransaction = useWalletStore((state) => state.signTransaction);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCommunities = useCallback(async () => {
    const query = address ? `?viewerAddress=${encodeURIComponent(address)}` : "";
    const result = await api<{ communities: Community[] }>(`/api/communities${query}`);
    setCommunities(result.communities);
    setSelectedId((current) => current ?? result.communities[0]?.id ?? null);
  }, [address]);

  const loadDashboard = useCallback(async () => {
    if (!selectedId) {
      setDashboard(null);
      return;
    }
    const query = address ? `?viewerAddress=${encodeURIComponent(address)}` : "";
    setDashboard(await api<Dashboard>(`/api/communities/${selectedId}${query}`));
  }, [address, selectedId]);

  const refresh = useCallback(async () => {
    await loadCommunities();
    await loadDashboard();
  }, [loadCommunities, loadDashboard]);

  useEffect(() => {
    loadCommunities().catch((cause) => setError((cause as Error).message));
  }, [loadCommunities]);

  useEffect(() => {
    loadDashboard().catch((cause) => setError((cause as Error).message));
    const timer = setInterval(() => loadDashboard().catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [loadDashboard]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    if (!address) throw new Error("Connect a wallet to participate.");
    const token = await getSmartHomeSession(address, signTransaction);
    await api(path, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await refresh();
  };

  const submit = async (event: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<void>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError(null);
    try {
      await action(form);
      formElement.reset();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isMember = Boolean(address && dashboard?.members.some((member) => member.address === address));

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl space-y-6 p-5 sm:p-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase text-emerald-400">Shared energy · member governance</p>
            <h1 className="mt-1 text-3xl font-bold">Energy Communities</h1>
          </div>
          <span className="text-sm text-white/60">{communities.length} communities</span>
        </header>

        {error && <p role="alert" className="border-s-2 border-red-500 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

        {address && (
          <form
            className="grid gap-3 border-b border-white/10 pb-6 sm:grid-cols-[1fr_1.5fr_auto]"
            onSubmit={(event) => submit(event, async (form) => {
              await mutate("/api/communities", "POST", {
                name: form.get("name"),
                description: form.get("description"),
              });
            })}
          >
            <input name="name" required minLength={2} maxLength={100} placeholder="Community name" className={INPUT} />
            <input name="description" maxLength={500} placeholder="What brings your community together?" className={INPUT} />
            <button className={BUTTON} disabled={busy}>Create community</button>
          </form>
        )}

        <div className="grid gap-8 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside aria-label="Community directory">
            <h2 className="mb-3 text-sm font-semibold uppercase text-white/60">Discover</h2>
            {communities.length === 0 ? (
              <p className="text-sm text-white/55">No communities yet.</p>
            ) : (
              <ul className="divide-y divide-white/10 border-y border-white/10">
                {communities.map((community) => (
                  <li key={community.id}>
                    <button
                      className={`w-full py-3 text-left ${selectedId === community.id ? "text-emerald-300" : "hover:text-white"}`}
                      onClick={() => setSelectedId(community.id)}
                    >
                      <span className="block font-medium">{community.name}</span>
                      <span className="mt-1 block text-xs text-white/55">
                        {community.memberCount} members · {community.pooledKwh.toFixed(1)} kWh pooled
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section aria-live="polite" className="min-w-0">
            {!dashboard ? (
              <p className="text-white/60">Select a community to see its shared resources and governance.</p>
            ) : (
              <div className="space-y-7">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-semibold">{dashboard.name}</h2>
                    {dashboard.description && <p className="mt-1 max-w-2xl text-sm text-white/65">{dashboard.description}</p>}
                  </div>
                  {address && (isMember ? (
                    <button className={BUTTON} disabled={busy} onClick={() => {
                      setBusy(true);
                      mutate(`/api/communities/${dashboard.id}/membership`, "DELETE")
                        .catch((cause) => setError((cause as Error).message))
                        .finally(() => setBusy(false));
                    }}>Leave</button>
                  ) : (
                    <button className={BUTTON} disabled={busy} onClick={() => {
                      setBusy(true);
                      mutate(`/api/communities/${dashboard.id}/join`, "POST")
                        .catch((cause) => setError((cause as Error).message))
                        .finally(() => setBusy(false));
                    }}>Join community</button>
                  ))}
                </header>

                <dl className="grid grid-cols-2 gap-x-5 gap-y-4 border-y border-white/10 py-4 sm:grid-cols-5">
                  <Metric label="Shared pool" value={`${dashboard.pooledKwh.toFixed(2)} kWh`} />
                  <Metric label="Contributed" value={`${dashboard.contributedKwh.toFixed(2)} kWh`} />
                  <Metric label="Allocated" value={`${dashboard.allocatedKwh.toFixed(2)} kWh`} />
                  <Metric label="Members" value={String(dashboard.memberCount)} />
                  <Metric label="Member discount" value={`${dashboard.discountPercent}%`} />
                  <Metric label="Discount benefit" value={`${(dashboard.discountedEnergyKwh ?? 0).toFixed(2)} kWh eq.`} />
                </dl>
                <p className="-mt-5 text-xs text-white/50">The member discount applies to energy charges on future bills.</p>

                {isMember && (
                  <div className="grid gap-6 border-b border-white/10 pb-6 md:grid-cols-2">
                    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => submit(event, async (form) => {
                      await mutate(`/api/communities/${dashboard.id}/energy/contributions`, "POST", { kwh: Number(form.get("kwh")) });
                    })}>
                      <label className="grid flex-1 gap-1 text-xs text-white/60">Contribute energy (kWh)
                        <input name="kwh" type="number" min="0.01" max="1000" step="0.01" required className={INPUT} />
                      </label>
                      <button className={BUTTON} disabled={busy}>Add to pool</button>
                    </form>
                    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => submit(event, async (form) => {
                      await mutate(`/api/communities/${dashboard.id}/energy/allocations`, "POST", { kwh: Number(form.get("kwh")) });
                    })}>
                      <label className="grid flex-1 gap-1 text-xs text-white/60">Allocate shared energy (kWh)
                        <input name="kwh" type="number" min="0.01" max="1000" step="0.01" required className={INPUT} />
                      </label>
                      <button className={BUTTON} disabled={busy}>Receive energy</button>
                    </form>
                  </div>
                )}

                <section>
                  <h3 className="mb-3 font-semibold">Governance · member discount</h3>
                  {isMember && (
                    <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_8rem_2fr_auto]" onSubmit={(event) => submit(event, async (form) => {
                      await mutate(`/api/communities/${dashboard.id}/governance/proposals`, "POST", {
                        title: form.get("title"),
                        discountPercent: Number(form.get("discountPercent")),
                        description: form.get("description"),
                      });
                    })}>
                      <input name="title" minLength={3} maxLength={100} required placeholder="Proposal title" className={INPUT} />
                      <input name="discountPercent" type="number" min="0" max="30" step="0.5" required placeholder="Discount %" className={INPUT} />
                      <input name="description" maxLength={500} placeholder="Proposal details" className={INPUT} />
                      <button className={BUTTON} disabled={busy}>Propose</button>
                    </form>
                  )}
                  {dashboard.proposals.length === 0 ? (
                    <p className="text-sm text-white/55">No proposals yet.</p>
                  ) : (
                    <ul className="divide-y divide-white/10 border-y border-white/10">
                      {dashboard.proposals.map((proposal) => (
                        <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="min-w-0">
                            <p className="font-medium">{proposal.title} <span className="text-emerald-300">{proposal.discountPercent}%</span></p>
                            {proposal.description && <p className="text-sm text-white/60">{proposal.description}</p>}
                            <p className="mt-1 text-xs text-white/50">
                              {proposal.yesVotes} yes · {proposal.noVotes} no · {proposal.eligibleVoters} eligible · {proposal.status}
                            </p>
                          </div>
                          {proposal.status === "open" && isMember && proposal.myVote === null && (
                            <div className="flex gap-2">
                              <button className={BUTTON} disabled={busy} onClick={() => vote(proposal.id, "yes")}>Yes</button>
                              <button className={BUTTON} disabled={busy} onClick={() => vote(proposal.id, "no")}>No</button>
                            </div>
                          )}
                          {proposal.status === "open" && isMember && proposal.myVote && (
                            <span className="text-xs text-white/55">Voted {proposal.myVote}</span>
                          )}
                          {proposal.status === "open" && Date.now() >= new Date(proposal.endsAt).getTime() && isMember && (
                            <button className={BUTTON} disabled={busy} onClick={() => finalize(proposal.id)}>Finalize</button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <div className="grid gap-6 md:grid-cols-2">
                  <section>
                    <h3 className="mb-3 font-semibold">Members</h3>
                    <ul className="space-y-2 text-sm">
                      {dashboard.members.map((member) => (
                        <li key={member.address} className="flex justify-between gap-3">
                          <span className="truncate">{member.address}</span>
                          <span className="text-white/50">{member.role}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h3 className="mb-3 font-semibold">Recent pool activity</h3>
                    {dashboard.energyTransactions.length === 0 ? (
                      <p className="text-sm text-white/55">No energy transactions yet.</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {dashboard.energyTransactions.map((transaction, index) => (
                          <li key={`${transaction.createdAt}-${index}`} className="flex flex-wrap justify-between gap-2">
                            <span>{transaction.type === "contribution" ? "Added" : "Allocated"} {transaction.kwh.toFixed(2)} kWh</span>
                            <span className="text-white/50">{transaction.memberAddress.slice(0, 8)}… · {new Date(transaction.createdAt).toLocaleDateString()}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );

  async function vote(proposalId: string, choice: "yes" | "no") {
    if (!dashboard) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/communities/${dashboard.id}/governance/proposals/${proposalId}/votes`, "POST", { choice });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finalize(proposalId: string) {
    if (!dashboard) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/communities/${dashboard.id}/governance/proposals/${proposalId}/finalize`, "POST");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-white/55">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}