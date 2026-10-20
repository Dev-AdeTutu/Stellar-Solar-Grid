"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";

interface Milestone { description: string; amount: number; votesFor: number; released: boolean }
interface Campaign { id: number; title: string; goal: number; raised: number; milestones: Milestone[] }

/**
 * Community crowdfunding portal. Actions map 1:1 to the `crowdfunding` Soroban
 * contract (contribute / vote / claim_returns). See contracts/CROWDFUNDING.md.
 */
export default function CrowdfundPage() {
  const { address, connect } = useWalletStore();
  const [campaigns, setCampaigns] = useState<Campaign[]>([
    {
      id: 0,
      title: "Village Mini-Grid 20kW",
      goal: 10000,
      raised: 4200,
      milestones: [
        { description: "Procure panels", amount: 6000, votesFor: 0, released: false },
        { description: "Install & commission", amount: 4000, votesFor: 0, released: false },
      ],
    },
  ]);
  const [amount, setAmount] = useState("");

  const contribute = (id: number) => {
    const n = Number(amount);
    if (!n || n <= 0) return;
    setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, raised: c.raised + n } : c)));
    setAmount("");
  };

  const vote = (id: number, mi: number) =>
    setCampaigns((cs) => cs.map((c) => c.id !== id ? c : {
      ...c,
      milestones: c.milestones.map((m, i) => (i === mi ? { ...m, votesFor: m.votesFor + 1 } : m)),
    }));

  return (
    <main className="min-h-screen">
      <Navbar />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <h1 className="text-2xl font-bold">Community Solar Crowdfunding</h1>
        {!address && <button onClick={connect} className="px-4 py-2 rounded bg-yellow-500 text-black">Connect Wallet</button>}
        {campaigns.map((c) => (
          <section key={c.id} className="border rounded p-4 space-y-3">
            <h2 className="font-semibold">{c.title}</h2>
            <div className="w-full bg-gray-700 rounded h-3">
              <div className="bg-yellow-400 h-3 rounded" style={{ width: `${Math.min(100, (c.raised / c.goal) * 100)}%` }} />
            </div>
            <p className="text-sm">{c.raised} / {c.goal} XLM raised</p>
            <div className="flex flex-wrap gap-2">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (XLM / USDC)" className="border rounded px-2 py-1 text-black flex-1 min-w-0" />
              <button disabled={!address} onClick={() => contribute(c.id)} className="px-4 py-1 rounded bg-yellow-500 text-black disabled:opacity-50">Contribute</button>
            </div>
            <h3 className="font-medium">Milestones (escrowed)</h3>
            <ul className="space-y-1">
              {c.milestones.map((m, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 text-sm">
                  <span>{m.description} — {m.amount} XLM {m.released && "✅"}</span>
                  <button disabled={!address} onClick={() => vote(c.id, i)} className="px-2 rounded border disabled:opacity-50">Approve ({m.votesFor})</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
