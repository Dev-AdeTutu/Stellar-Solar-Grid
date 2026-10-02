"use client";

import { useEffect, useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

type Level = { price: number; kwh: number; cumulative: number };
type Trade = { id: string; price: number; kwh: number; time: string };
type Snapshot = { bids: Level[]; asks: Level[]; spread: number | null; trades: Trade[] };

const EMPTY: Snapshot = { bids: [], asks: [], spread: null, trades: [] };

function DepthChart({ bids, asks }: { bids: Level[]; asks: Level[] }) {
  const max = Math.max(1, bids[bids.length - 1]?.cumulative ?? 0, asks[asks.length - 1]?.cumulative ?? 0);
  const n = Math.max(bids.length, asks.length, 1);
  const pts = (levels: Level[], dir: 1 | -1) =>
    levels.map((l, i) => `${50 + (dir * (i + 1) * 50) / n},${100 - (l.cumulative / max) * 100}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-48 bg-gray-900 rounded" aria-label="Market depth">
      <polyline fill="none" stroke="#22c55e" strokeWidth="1" points={`50,100 ${pts(bids, -1)}`} />
      <polyline fill="none" stroke="#ef4444" strokeWidth="1" points={`50,100 ${pts(asks, 1)}`} />
    </svg>
  );
}

function Side({ title, levels, color }: { title: string; levels: Level[]; color: string }) {
  const max = Math.max(1, levels[levels.length - 1]?.cumulative ?? 0);
  return (
    <div>
      <h2 className="font-semibold mb-2">{title}</h2>
      <div className="text-xs grid grid-cols-3 text-gray-400 mb-1">
        <span>Price (XLM)</span>
        <span className="text-right">kWh</span>
        <span className="text-right">Total</span>
      </div>
      {levels.map((l) => (
        <div key={l.price} className="relative grid grid-cols-3 text-sm py-0.5">
          <div className={`absolute inset-y-0 right-0 opacity-20 ${color}`} style={{ width: `${(l.cumulative / max) * 100}%` }} />
          <span className="relative">{l.price.toFixed(4)}</span>
          <span className="relative text-right">{l.kwh.toFixed(2)}</span>
          <span className="relative text-right">{l.cumulative.toFixed(2)}</span>
        </div>
      ))}
      {levels.length === 0 && <p className="text-sm text-gray-500">No open orders</p>}
    </div>
  );
}

export default function OrderBookPage() {
  const [book, setBook] = useState<Snapshot>(EMPTY);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(`${env.NEXT_PUBLIC_BACKEND_URL.replace(/^http/, "ws")}/api/orderbook/ws`);
    ws.onopen = () => setLive(true);
    ws.onclose = () => setLive(false);
    ws.onmessage = (e) => setBook(JSON.parse(e.data) as Snapshot);
    return () => ws.close();
  }, []);

  const trades = useMemo(() => book.trades.slice(0, 15), [book.trades]);

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Energy Order Book</h1>
          <span className={`text-sm ${live ? "text-green-500" : "text-gray-400"}`}>{live ? "● Live" : "○ Disconnected"}</span>
        </div>
        {book.spread !== null && <p className="text-sm text-gray-400">Spread: {book.spread.toFixed(4)} XLM/kWh</p>}
        <DepthChart bids={book.bids} asks={book.asks} />
        <div className="grid md:grid-cols-2 gap-6">
          <Side title="Bids" levels={book.bids} color="bg-green-500" />
          <Side title="Asks" levels={book.asks} color="bg-red-500" />
        </div>
        <section>
          <h2 className="font-semibold mb-2">Recent Trades</h2>
          {trades.map((t) => (
            <div key={t.id} className="grid grid-cols-3 text-sm py-0.5">
              <span>{t.price.toFixed(4)}</span>
              <span className="text-right">{t.kwh.toFixed(2)} kWh</span>
              <span className="text-right text-gray-400">{new Date(t.time).toLocaleTimeString()}</span>
            </div>
          ))}
          {trades.length === 0 && <p className="text-sm text-gray-500">No trades yet</p>}
        </section>
      </main>
    </>
  );
}
