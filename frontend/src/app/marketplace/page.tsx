"use client";

import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useToast } from "@/components/ToastProvider";
import { useWalletStore } from "@/store/walletStore";
import { publishAlgorithm, subscribeAlgorithm } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";

const API = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

type Metrics = { trades: number; pnl: number; returnPct: number; winRate: number; maxDrawdown: number };

/** Synthetic 7-day hourly market used for quick backtests in the browser. */
function sampleTicks() {
  return Array.from({ length: 168 }, (_, i) => ({
    ts: new Date(Date.now() - (168 - i) * 3_600_000).toISOString(),
    price: 10 + 3 * Math.sin(i / 4) + Math.random(),
    supplyKwh: 4 + 6 * Math.max(0, Math.sin(((i % 24) - 6) / 4)),
    demandKwh: 6,
  }));
}

export default function MarketplacePage() {
  const { showToast } = useToast();
  const { address } = useWalletStore();
  const [strategies, setStrategies] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [name, setName] = useState("");
  const [fee, setFee] = useState("1");
  const [algoId, setAlgoId] = useState("");

  useEffect(() => {
    fetch(`${API}/api/algos/strategies`)
      .then((r) => r.json())
      .then(setStrategies)
      .catch(() => showToast({ title: "Failed to load strategies", variant: "error" }));
  }, [showToast]);

  async function runBacktest(strategy: string) {
    const res = await fetch(`${API}/api/algos/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy, ticks: sampleTicks() }),
    });
    const m = await res.json();
    setMetrics((prev) => ({ ...prev, [strategy]: m }));
  }

  async function withWallet(fn: (addr: string) => Promise<string>, ok: string) {
    if (!address) return showToast({ title: "Connect your wallet first", variant: "error" });
    try {
      await fn(address);
      showToast({ title: ok, variant: "success" });
    } catch (err) {
      showToast({ title: parseWalletError(err), variant: "error" });
    }
  }

  return (
    <main className="min-h-screen">
      <Navbar />
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-solar-yellow">Algorithm Marketplace</h1>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Strategies</h2>
          {strategies.map((s) => (
            <div key={s} className="flex flex-wrap items-center justify-between gap-3 border border-white/10 rounded p-3">
              <span className="font-mono">{s}</span>
              {metrics[s] && (
                <span className="text-sm text-white/70">
                  {metrics[s].trades} trades · return {metrics[s].returnPct.toFixed(2)}% · win{" "}
                  {(metrics[s].winRate * 100).toFixed(0)}% · max DD {(metrics[s].maxDrawdown * 100).toFixed(1)}%
                </span>
              )}
              <button className="px-3 py-1 rounded bg-white/10" onClick={() => runBacktest(s)}>
                Backtest
              </button>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Subscribe</h2>
          <div className="flex flex-wrap gap-2">
            <input className="px-3 py-2 rounded bg-white/5" placeholder="Algorithm ID" value={algoId}
              onChange={(e) => setAlgoId(e.target.value)} />
            <button className="px-4 py-2 rounded bg-solar-yellow text-black"
              onClick={() => withWallet((a) => subscribeAlgorithm(a, Number(algoId)), "Subscribed")}>
              Subscribe
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Publish an algorithm</h2>
          <p className="text-sm text-white/60">Creators receive 90% of every subscription fee.</p>
          <div className="flex flex-wrap gap-2">
            <input className="px-3 py-2 rounded bg-white/5" placeholder="Strategy name" value={name}
              onChange={(e) => setName(e.target.value)} />
            <input className="px-3 py-2 rounded bg-white/5 w-28" type="number" min="0" placeholder="Fee (XLM)"
              value={fee} onChange={(e) => setFee(e.target.value)} />
            <button className="px-4 py-2 rounded bg-solar-yellow text-black"
              onClick={() => withWallet((a) => publishAlgorithm(a, name, Number(fee)), "Algorithm published")}>
              Publish
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
