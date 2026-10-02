"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";
import { useWalletStore } from "@/store/walletStore";
import { usePaymentStore } from "@/store/paymentStore";

const API = env.NEXT_PUBLIC_BACKEND_URL;
type Quote = { timestamp: string; pricePerKwh: number; source: string };
type MarketPrice = Quote;
type Account = { cash: number; energyKwh: number; marketValue: number; totalValue: number; pnl: number };
type Trade = { id: number; side: "buy" | "sell"; quantityKwh: number; pricePerKwh: number; fee: number; executedAt: string };
type LeaderboardEntry = Account & { rank: number };

function credits(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
}

export default function SimulatorPage() {
  const { address, connect } = useWalletStore();
  const meterId = usePaymentStore((state) => state.meterId);
  const [market, setMarket] = useState<MarketPrice[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [feeRate, setFeeRate] = useState(0.005);
  const [account, setAccount] = useState<Account | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("1");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const [marketResponse, leaderboardResponse] = await Promise.all([
          fetch(`${API}/api/simulator/market?hours=24`),
          fetch(`${API}/api/simulator/leaderboard?limit=10`),
        ]);
        if (!marketResponse.ok || !leaderboardResponse.ok) throw new Error("Market data is temporarily unavailable");
        const marketData = await marketResponse.json();
        const leaderboardData = await leaderboardResponse.json();
        if (!stopped) {
          setMarket(marketData.prices ?? []);
          setQuote(marketData.current ?? null);
          setLeaderboard(leaderboardData.entries ?? []);
          setFeeRate(marketData.feeRate ?? 0.005);
        }
      } catch (error) {
        if (!stopped) setMessage(error instanceof Error ? error.message : "Market data unavailable");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!address || !meterId) {
      setAccount(null);
      setTrades([]);
      return;
    }
    let stopped = false;
    const params = new URLSearchParams({ stellarAddress: address, meterId });
    fetch(`${API}/api/simulator/account?${params}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load simulator account");
        if (!stopped) {
          setAccount(data.account);
          setTrades(data.trades ?? []);
          setQuote(data.quote);
          setFeeRate(data.feeRate ?? 0.005);
        }
      })
      .catch((error: Error) => {
        if (!stopped) setMessage(error.message);
      });
    return () => { stopped = true; };
  }, [address, meterId]);

  async function executeTrade(event: React.FormEvent) {
    event.preventDefault();
    if (!address || !meterId) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${API}/api/simulator/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meterId, stellarAddress: address, side, quantityKwh: Number(quantity) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Trade rejected");
      setAccount(result.account);
      setFeeRate(result.feeRate ?? 0.005);
      setTrades((current) => [result.trade, ...current].slice(0, 50));
      setMessage(`${side === "buy" ? "Bought" : "Sold"} ${result.trade.quantityKwh} kWh using virtual credits.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade could not be completed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-emerald-300">Trading academy</p>
            <h1 className="mt-1 text-2xl font-semibold">Energy market practice</h1>
          </div>
          <p className="text-xs text-gray-400">Practice credits only. No real funds or energy contracts are used.</p>
        </header>

        {message && <p role="status" className="border-l-2 border-amber-400 px-3 py-2 text-sm text-amber-200">{message}</p>}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Wholesale day-ahead price</h2>
              <p className="text-xs text-gray-400">
                {quote ? `${credits(quote.pricePerKwh)} / kWh · ${quote.source}` : "Loading market quote"}
              </p>
            </div>
            <div className="mt-3 h-64 w-full">
              {market.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={market} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="#ffffff16" vertical={false} />
                    <XAxis dataKey="timestamp" tickFormatter={(value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric" })} tick={{ fill: "#9ca3af", fontSize: 10 }} minTickGap={24} />
                    <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} width={48} />
                    <Tooltip labelFormatter={(value: string) => new Date(value).toLocaleString()} formatter={(value: number) => [credits(Number(value)), "EUR / kWh"]} />
                    <Line type="monotone" dataKey="pricePerKwh" stroke="#34d399" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <p className="flex h-full items-center justify-center text-sm text-gray-500">Waiting for market data</p>}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 border-y border-white/10 py-4 sm:grid-cols-4">
              <div><p className="text-xs text-gray-400">Virtual cash</p><p className="mt-1 font-semibold">{account ? credits(account.cash) : "--"}</p></div>
              <div><p className="text-xs text-gray-400">Energy holdings</p><p className="mt-1 font-semibold">{account ? `${account.energyKwh.toFixed(3)} kWh` : "--"}</p></div>
              <div><p className="text-xs text-gray-400">Portfolio value</p><p className="mt-1 font-semibold">{account ? credits(account.totalValue) : "--"}</p></div>
              <div><p className="text-xs text-gray-400">Practice P&amp;L</p><p className={`mt-1 font-semibold ${account && account.pnl < 0 ? "text-rose-300" : "text-emerald-300"}`}>{account ? credits(account.pnl) : "--"}</p></div>
            </div>

            <section className="mt-5">
              <h2 className="text-sm font-semibold">Recent practice trades</h2>
              {trades.length === 0 ? <p className="mt-3 text-sm text-gray-500">No practice trades yet.</p> : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[480px] text-left text-xs">
                    <thead className="text-gray-400"><tr><th className="py-2">Side</th><th>Energy</th><th>Price</th><th>Fee</th><th>Time</th></tr></thead>
                    <tbody className="divide-y divide-white/10">
                      {trades.map((trade) => <tr key={trade.id}>
                        <td className={`py-2 font-medium capitalize ${trade.side === "buy" ? "text-emerald-300" : "text-amber-300"}`}>{trade.side}</td>
                        <td>{trade.quantityKwh.toFixed(3)} kWh</td><td>{credits(trade.pricePerKwh)}/kWh</td>
                        <td>{credits(trade.fee)}</td><td>{new Date(trade.executedAt).toLocaleString()}</td>
                      </tr>)}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <aside className="border-l border-white/10 pl-0 lg:pl-6">
            <h2 className="text-sm font-semibold">Place a practice trade</h2>
            {!address ? (
              <button type="button" onClick={() => connect()} className="mt-4 min-h-10 border border-white/20 px-3 text-sm hover:border-emerald-300">Connect wallet</button>
            ) : !meterId ? (
              <p className="mt-3 text-sm text-gray-400">Choose one of your meters on the dashboard before trading.</p>
            ) : !account ? (
              <p className="mt-3 text-sm text-gray-400">Verifying meter ownership and loading your practice account.</p>
            ) : (
              <form onSubmit={executeTrade} className="mt-4 space-y-4">
                <div role="group" aria-label="Trade side" className="grid grid-cols-2 border border-white/15">
                  {(["buy", "sell"] as const).map((option) => <button key={option} type="button" aria-pressed={side === option} onClick={() => setSide(option)} className={`min-h-10 capitalize ${side === option ? "bg-emerald-400 text-gray-950" : "text-gray-300"}`}>{option}</button>)}
                </div>
                <label className="block text-xs text-gray-400" htmlFor="simulator-quantity">Energy quantity (kWh)</label>
                <input id="simulator-quantity" type="number" min="0.001" max="100000" step="0.001" required value={quantity} onChange={(event) => setQuantity(event.target.value)} className="min-h-10 w-full border border-white/20 bg-transparent px-3 text-sm text-white" />
                {quote && <p className="text-xs text-gray-400">Estimated settlement: {credits(Number(quantity || 0) * quote.pricePerKwh + Math.abs(Number(quantity || 0) * quote.pricePerKwh) * feeRate * (side === "buy" ? 1 : -1))} including {(feeRate * 100).toFixed(2)}% practice fee.</p>}
                <button disabled={busy || !quote} type="submit" className="min-h-10 w-full bg-emerald-400 px-3 text-sm font-semibold text-gray-950 disabled:opacity-50">{busy ? "Executing" : `${side === "buy" ? "Buy" : "Sell"} energy`}</button>
              </form>
            )}

            <div className="mt-8 border-t border-white/10 pt-4">
              <h2 className="text-sm font-semibold">Practice leaderboard</h2>
              {leaderboard.length === 0 ? <p className="mt-3 text-sm text-gray-500">Your portfolio can appear here after your first trade.</p> : (
                <ol className="mt-2 divide-y divide-white/10">
                  {leaderboard.map((entry) => <li key={entry.rank} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate text-gray-300">{entry.rank}. Trader {entry.rank}</span>
                    <span className="shrink-0 font-medium">{credits(entry.totalValue)}</span>
                  </li>)}
                </ol>
              )}
            </div>
          </aside>
        </section>

        <details className="border-y border-white/10 py-4">
          <summary className="cursor-pointer text-sm font-semibold">Trading academy: fundamentals</summary>
          <ol className="mt-3 grid gap-3 text-sm text-gray-300 sm:grid-cols-3">
            <li><strong className="text-white">1. Read the market.</strong> Review the historical price curve and current quote before choosing a position.</li>
            <li><strong className="text-white">2. Size your trade.</strong> A buy spends virtual cash plus a 0.5% fee; a sell is limited to your practice holdings.</li>
            <li><strong className="text-white">3. Review performance.</strong> Portfolio value marks open energy at the latest quote; realized and unrealized changes count toward practice P&amp;L.</li>
          </ol>
        </details>
      </main>
    </>
  );
}