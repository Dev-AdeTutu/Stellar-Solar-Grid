"use client";

import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type TradeDirection = "sell" | "buy";
type TradeStatus = "open" | "matched" | "settled" | "cancelled" | "disputed";

type TradeOffer = {
  id: string;
  userId: string;
  direction: TradeDirection;
  energyKwh: number;
  pricePerKwh: number;
  minKwh: number;
  status: TradeStatus;
  createdAt: string;
  expiresAt: string;
  location: string | null;
};

type TradeMatch = {
  id: string;
  sellOfferId: string;
  buyOfferId: string;
  energyKwh: number;
  pricePerKwh: number;
  totalXlm: number;
  fee: number;
  sellerNet: number;
  matchedAt: string;
  status: TradeStatus;
  settledAt: string | null;
  disputeReason: string | null;
};

type TradingStats = {
  openSellOffers: number;
  openBuyOffers: number;
  totalMatches: number;
  totalSettled: number;
  totalVolumeKwh: number;
  totalVolumeXlm: number;
};

const STATUS_BADGE: Record<TradeStatus, string> = {
  open: "bg-green-900/40 text-green-400",
  matched: "bg-yellow-900/40 text-yellow-400",
  settled: "bg-blue-900/40 text-blue-400",
  cancelled: "bg-gray-900/40 text-gray-400",
  disputed: "bg-red-900/40 text-red-400",
};

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
}

export default function P2PTradingPage() {
  const { address } = useWalletStore();
  const { showToast } = useToast();

  const [stats, setStats] = useState<TradingStats | null>(null);
  const [openOffers, setOpenOffers] = useState<TradeOffer[]>([]);
  const [myOffers, setMyOffers] = useState<TradeOffer[]>([]);
  const [myMatches, setMyMatches] = useState<TradeMatch[]>([]);
  const [tab, setTab] = useState<"market" | "my-offers" | "my-trades">("market");

  const [direction, setDirection] = useState<TradeDirection>("sell");
  const [energyKwh, setEnergyKwh] = useState("");
  const [pricePerKwh, setPricePerKwh] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([
        fetch(`${API}/api/p2p/stats`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/p2p/offers`).then((r) => (r.ok ? r.json() : { offers: [] })),
      ]);
      setStats(s);
      setOpenOffers(o.offers ?? []);

      if (address) {
        const [mo, mm] = await Promise.all([
          fetch(`${API}/api/p2p/user/${encodeURIComponent(address)}/offers`).then((r) =>
            r.ok ? r.json() : { offers: [] },
          ),
          fetch(`${API}/api/p2p/user/${encodeURIComponent(address)}/matches`).then((r) =>
            r.ok ? r.json() : { matches: [] },
          ),
        ]);
        setMyOffers(mo.offers ?? []);
        setMyMatches(mm.matches ?? []);
      }
    } catch {
      // non-fatal
    }
  }, [address]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function handleCreateOffer() {
    if (!address) return showToast({ title: "Connect wallet first", variant: "error" });
    const kwh = Number(energyKwh);
    const price = Number(pricePerKwh);
    if (!Number.isFinite(kwh) || kwh <= 0 || !Number.isFinite(price) || price <= 0) {
      return showToast({ title: "Enter valid kWh and price", variant: "error" });
    }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/p2p/offers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: address,
          direction,
          energyKwh: kwh,
          pricePerKwh: price,
          location: location || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create offer");
      showToast({ title: "Offer created", description: `${direction} ${kwh} kWh at ${price} XLM/kWh` });
      setEnergyKwh("");
      setPricePerKwh("");
      setLocation("");
      await load();
    } catch (e) {
      showToast({ title: "Create failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(offerId: string) {
    if (!address) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/p2p/offers/${encodeURIComponent(offerId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to cancel offer");
      showToast({ title: "Offer cancelled" });
      await load();
    } catch (e) {
      showToast({ title: "Cancel failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleSettle(matchId: string) {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/p2p/matches/${encodeURIComponent(matchId)}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to settle");
      showToast({ title: "Trade settled" });
      await load();
    } catch (e) {
      showToast({ title: "Settle failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const TABS = [
    { key: "market", label: "Open Market" },
    { key: "my-offers", label: "My Offers" },
    { key: "my-trades", label: "My Trades" },
  ] as const;

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">P2P Energy Trading</h1>
        <p className="opacity-60 text-sm mb-6">
          Trade energy directly with your neighbors. Post a sell or buy offer and let the matching
          algorithm find compatible pairs.
        </p>

        {stats && (
          <section aria-label="Trading stats" className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
            <StatCard label="Open sell offers" value={String(stats.openSellOffers)} />
            <StatCard label="Open buy offers" value={String(stats.openBuyOffers)} />
            <StatCard label="Total settled" value={String(stats.totalSettled)} />
            <StatCard label="Volume (kWh)" value={stats.totalVolumeKwh.toLocaleString()} />
            <StatCard label="Volume (XLM)" value={stats.totalVolumeXlm.toFixed(2)} />
            <StatCard label="All matches" value={String(stats.totalMatches)} />
          </section>
        )}

        <section className="rounded-xl border border-white/10 bg-white/5 p-5 mb-8">
          <h2 className="text-lg font-semibold mb-3">Create Offer</h2>
          <div className="grid sm:grid-cols-4 gap-3">
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as TradeDirection)}
              className="rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
            >
              <option value="sell">Sell energy</option>
              <option value="buy">Buy energy</option>
            </select>
            <input
              type="number"
              min={0}
              step="any"
              value={energyKwh}
              onChange={(e) => setEnergyKwh(e.target.value)}
              placeholder="kWh"
              className="rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
            />
            <input
              type="number"
              min={0}
              step="any"
              value={pricePerKwh}
              onChange={(e) => setPricePerKwh(e.target.value)}
              placeholder="Price (XLM/kWh)"
              className="rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Location (optional)"
              className="rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={handleCreateOffer}
            disabled={busy || !address}
            className="mt-3 rounded-lg bg-yellow-500 text-black font-medium px-5 py-2 text-sm hover:bg-yellow-400 disabled:opacity-40"
          >
            {busy ? "Posting…" : "Post Offer"}
          </button>
          {!address && <p className="text-xs opacity-60 mt-2">Connect your wallet to post offers.</p>}
        </section>

        <div className="flex gap-2 mb-4 border-b border-white/10 pb-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                tab === t.key ? "bg-white/10" : "opacity-60 hover:opacity-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "market" && (
          <div className="grid sm:grid-cols-2 gap-4">
            {openOffers.length === 0 && <p className="opacity-60 col-span-2">No open offers yet.</p>}
            {openOffers.map((o) => (
              <div
                key={o.id}
                className={`rounded-xl border p-4 ${
                  o.direction === "sell" ? "border-green-700/40 bg-green-900/20" : "border-blue-700/40 bg-blue-900/20"
                }`}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className={`text-xs font-medium uppercase ${o.direction === "sell" ? "text-green-400" : "text-blue-400"}`}>
                    {o.direction}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[o.status]}`}>{o.status}</span>
                </div>
                <div className="text-2xl font-semibold tabular-nums">{o.energyKwh} kWh</div>
                <div className="text-sm opacity-70">{o.pricePerKwh.toFixed(4)} XLM/kWh</div>
                {o.location && <div className="text-xs opacity-50 mt-1">{o.location}</div>}
                <div className="text-xs opacity-40 mt-1">
                  Expires {new Date(o.expiresAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "my-offers" && (
          <div className="rounded-xl border border-white/10 overflow-hidden">
            {myOffers.length === 0 ? (
              <p className="p-4 opacity-60">No offers yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-white/5 text-xs uppercase opacity-60">
                  <tr>
                    <th className="px-4 py-2 text-left">Dir</th>
                    <th className="px-4 py-2 text-right">kWh</th>
                    <th className="px-4 py-2 text-right">XLM/kWh</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {myOffers.map((o) => (
                    <tr key={o.id} className="border-t border-white/5">
                      <td className={`px-4 py-2 capitalize font-medium ${o.direction === "sell" ? "text-green-400" : "text-blue-400"}`}>
                        {o.direction}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{o.energyKwh}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{o.pricePerKwh.toFixed(4)}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[o.status]}`}>{o.status}</span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {o.status === "open" && (
                          <button
                            onClick={() => handleCancel(o.id)}
                            disabled={busy}
                            className="text-xs text-gray-400 hover:text-red-400 border border-white/10 rounded px-2 py-0.5"
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === "my-trades" && (
          <div className="space-y-3">
            {myMatches.length === 0 && <p className="opacity-60">No trades yet.</p>}
            {myMatches.map((m) => (
              <div key={m.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-mono text-xs opacity-60">{m.id.slice(0, 22)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[m.status]}`}>{m.status}</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="opacity-60 text-xs">Energy</div>
                    <div className="font-semibold tabular-nums">{m.energyKwh} kWh</div>
                  </div>
                  <div>
                    <div className="opacity-60 text-xs">Settlement price</div>
                    <div className="font-semibold tabular-nums">{m.pricePerKwh.toFixed(4)} XLM/kWh</div>
                  </div>
                  <div>
                    <div className="opacity-60 text-xs">Total (net fee)</div>
                    <div className="font-semibold tabular-nums">{m.sellerNet.toFixed(4)} XLM</div>
                  </div>
                </div>
                {m.status === "matched" && (
                  <button
                    onClick={() => handleSettle(m.id)}
                    disabled={busy}
                    className="mt-3 rounded-lg bg-blue-600 text-white text-sm font-medium px-4 py-1.5 hover:bg-blue-500 disabled:opacity-40"
                  >
                    Settle Trade
                  </button>
                )}
                {m.disputeReason && (
                  <p className="text-xs text-red-400 mt-2">Dispute: {m.disputeReason}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
