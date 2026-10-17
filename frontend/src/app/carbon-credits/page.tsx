"use client";

import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type CreditStatus = "issued" | "retired" | "listed" | "sold";

type CarbonCredit = {
  id: string;
  ownerId: string;
  kwhProduced: number;
  creditsIssued: number;
  vintage: string;
  registryRef: string;
  status: CreditStatus;
  issuedAt: string;
  retiredAt: string | null;
};

type MarketListing = {
  creditId: string;
  sellerId: string;
  pricePerCredit: number;
  quantity: number;
  listedAt: string;
};

type Stats = {
  totalIssued: number;
  totalRetired: number;
  totalListed: number;
  totalCreditValue: number;
};

const STATUS_COLORS: Record<CreditStatus, string> = {
  issued: "text-blue-400",
  retired: "text-gray-400",
  listed: "text-yellow-400",
  sold: "text-green-400",
};

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
}

export default function CarbonCreditsPage() {
  const { address } = useWalletStore();
  const { showToast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [myCredits, setMyCredits] = useState<CarbonCredit[]>([]);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [kwhInput, setKwhInput] = useState("");
  const [listCreditId, setListCreditId] = useState("");
  const [listPrice, setListPrice] = useState("");
  const [listQty, setListQty] = useState("");
  const [busy, setBusy] = useState(false);

  // Issue #972: Carbon Footprint Calculator state
  const [calcMeterId, setCalcMeterId] = useState("");
  const [calcRegion, setCalcRegion] = useState("Default");
  const [footprint, setFootprint] = useState<any>(null);
  const [loadingFootprint, setLoadingFootprint] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        fetch(`${API}/api/carbon-credits/stats`).then((r) => (r.ok ? r.json() : Promise.reject())),
        fetch(`${API}/api/carbon-credits/marketplace`).then((r) => (r.ok ? r.json() : Promise.reject())),
      ]);
      setStats(s);
      setListings(m.listings ?? []);

      if (address) {
        const mine = await fetch(`${API}/api/carbon-credits/owner/${encodeURIComponent(address)}`).then((r) =>
          r.ok ? r.json() : { credits: [] },
        );
        setMyCredits(mine.credits ?? []);
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

  async function handleIssue() {
    if (!address) return showToast({ title: "Connect wallet first", variant: "error" });
    const kwh = Number(kwhInput);
    if (!Number.isFinite(kwh) || kwh <= 0) {
      return showToast({ title: "Enter a valid kWh amount", variant: "error" });
    }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/carbon-credits/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerId: address, kwhProduced: kwh }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to issue credit");
      showToast({ title: "Credits issued", description: `${data.creditsIssued.toFixed(4)} credits (${data.id})` });
      setKwhInput("");
      await load();
    } catch (e) {
      showToast({ title: "Issue failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleRetire(creditId: string) {
    if (!address) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/carbon-credits/${encodeURIComponent(creditId)}/retire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to retire credit");
      showToast({ title: "Credit retired", description: `${creditId} has been permanently offset` });
      await load();
    } catch (e) {
      showToast({ title: "Retire failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleList() {
    if (!address || !listCreditId) return;
    const price = Number(listPrice);
    const qty = Number(listQty);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
      return showToast({ title: "Enter valid price and quantity", variant: "error" });
    }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/carbon-credits/${encodeURIComponent(listCreditId)}/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId: address, pricePerCredit: price, quantity: qty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to list credit");
      showToast({ title: "Credit listed", description: `${qty} credits at ${price} XLM each` });
      setListCreditId("");
      setListPrice("");
      setListQty("");
      await load();
    } catch (e) {
      showToast({ title: "List failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handlePurchase(creditId: string) {
    if (!address) return showToast({ title: "Connect wallet first", variant: "error" });
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/carbon-credits/${encodeURIComponent(creditId)}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyerId: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to purchase credit");
      showToast({ title: "Credit purchased", description: `Credit ${creditId} is now yours` });
      await load();
    } catch (e) {
      showToast({ title: "Purchase failed", description: (e as Error).message, variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function fetchFootprint() {
    if (!calcMeterId.trim()) {
      return showToast({ title: "Enter a meter ID", variant: "error" });
    }
    setLoadingFootprint(true);
    try {
      const res = await fetch(
        `${API}/api/meters/${encodeURIComponent(calcMeterId.trim())}/carbon-footprint?region=${encodeURIComponent(calcRegion)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to calculate carbon footprint");
      setFootprint(data);
    } catch (e) {
      showToast({ title: "Calculation failed", description: (e as Error).message, variant: "error" });
    } finally {
      setLoadingFootprint(false);
    }
  }

  function handleCopyBadgeSvg() {
    if (!footprint?.badge?.svgBadge) return;
    navigator.clipboard.writeText(footprint.badge.svgBadge);
    showToast({ title: "Badge SVG copied to clipboard", description: "Paste it anywhere to share your solar impact!" });
  }

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Carbon Credit Tracking</h1>
        <p className="opacity-60 text-sm mb-6">
          Issue, trade, and retire blockchain-verified carbon credits for renewable energy production.
          1 credit = 1 tonne CO₂ offset = 2000 kWh generated.
        </p>

        {stats && (
          <section aria-label="Platform stats" className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <StatCard label="Total issued" value={stats.totalIssued.toFixed(2)} />
            <StatCard label="Total retired" value={stats.totalRetired.toFixed(2)} />
            <StatCard label="Listed" value={stats.totalListed.toFixed(2)} />
            <StatCard label="Market value (XLM)" value={stats.totalCreditValue.toFixed(2)} />
          </section>
        )}

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="text-lg font-semibold mb-3">Issue Credits</h2>
            <p className="text-xs opacity-60 mb-3">
              Enter the kWh your panels produced to receive carbon credits.
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                step="any"
                value={kwhInput}
                onChange={(e) => setKwhInput(e.target.value)}
                placeholder="kWh produced"
                className="flex-1 rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
              />
              <button
                onClick={handleIssue}
                disabled={busy || !address}
                className="rounded-lg bg-yellow-500 text-black font-medium px-4 py-2 text-sm hover:bg-yellow-400 disabled:opacity-40"
              >
                Issue
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="text-lg font-semibold mb-3">List Credit for Sale</h2>
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={listCreditId}
                onChange={(e) => setListCreditId(e.target.value)}
                placeholder="Credit ID"
                className="rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
              />
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={listPrice}
                  onChange={(e) => setListPrice(e.target.value)}
                  placeholder="Price per credit (XLM)"
                  className="flex-1 rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={listQty}
                  onChange={(e) => setListQty(e.target.value)}
                  placeholder="Quantity"
                  className="w-24 rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <button
                onClick={handleList}
                disabled={busy || !address || !listCreditId}
                className="rounded-lg bg-blue-600 text-white font-medium px-4 py-2 text-sm hover:bg-blue-500 disabled:opacity-40"
              >
                List for Sale
              </button>
            </div>
          </section>
        </div>

        {/* Issue #972: Carbon Footprint Calculator */}
        <section aria-label="Carbon Footprint Calculator" className="rounded-xl border border-emerald-500/30 bg-emerald-950/10 p-6 mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="text-xl font-bold flex items-center gap-2">
                <span>🌱</span> Carbon Footprint Calculator
              </h2>
              <p className="text-xs opacity-70">
                Calculate CO2 emissions avoided by solar generation versus regional fossil grid power.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-6">
            <input
              type="text"
              value={calcMeterId}
              onChange={(e) => setCalcMeterId(e.target.value)}
              placeholder="Enter Meter ID (e.g. MTR_001)"
              className="flex-1 min-w-[200px] rounded-lg border border-white/20 bg-transparent px-3 py-2 text-sm"
            />
            <select
              value={calcRegion}
              onChange={(e) => setCalcRegion(e.target.value)}
              className="rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm text-white"
            >
              <option value="Default">Default Grid (0.500 kg/kWh)</option>
              <option value="US">US Grid (0.385 kg/kWh)</option>
              <option value="EU">EU Grid (0.250 kg/kWh)</option>
              <option value="CA">California / Clean (0.210 kg/kWh)</option>
              <option value="Coal">Coal-Heavy Grid (0.850 kg/kWh)</option>
            </select>
            <button
              onClick={fetchFootprint}
              disabled={loadingFootprint}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-5 py-2 text-sm disabled:opacity-50"
            >
              {loadingFootprint ? "Calculating..." : "Calculate Footprint"}
            </button>
          </div>

          {footprint && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Lifetime */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wider text-emerald-400 mb-2">
                    Lifetime Savings ({footprint.lifetime.kwh} kWh)
                  </div>
                  <div className="text-2xl font-bold tabular-nums mb-2">
                    {footprint.lifetime.kgCo2Saved} <span className="text-sm font-normal opacity-70">kg CO2</span>
                  </div>
                  <div className="text-xs opacity-80 space-y-1">
                    <div>🌳 <strong>{footprint.lifetime.treesEquivalent}</strong> tree-years equivalent</div>
                    <div>🚗 <strong>{footprint.lifetime.carMilesOffset}</strong> car miles offset</div>
                  </div>
                </div>

                {/* Monthly */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wider text-emerald-400 mb-2">
                    Monthly Savings (Past 30 Days)
                  </div>
                  <div className="text-2xl font-bold tabular-nums mb-2">
                    {footprint.monthly.kgCo2Saved} <span className="text-sm font-normal opacity-70">kg CO2</span>
                  </div>
                  <div className="text-xs opacity-80 space-y-1">
                    <div>🌳 <strong>{footprint.monthly.treesEquivalent}</strong> tree-years equivalent</div>
                    <div>🚗 <strong>{footprint.monthly.carMilesOffset}</strong> car miles offset</div>
                  </div>
                </div>

                {/* Yearly */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wider text-emerald-400 mb-2">
                    Yearly Savings (Past 365 Days)
                  </div>
                  <div className="text-2xl font-bold tabular-nums mb-2">
                    {footprint.yearly.kgCo2Saved} <span className="text-sm font-normal opacity-70">kg CO2</span>
                  </div>
                  <div className="text-xs opacity-80 space-y-1">
                    <div>🌳 <strong>{footprint.yearly.treesEquivalent}</strong> tree-years equivalent</div>
                    <div>🚗 <strong>{footprint.yearly.carMilesOffset}</strong> car miles offset</div>
                  </div>
                </div>
              </div>

              {/* Shareable Badge */}
              {footprint.badge && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl border border-emerald-500/20 bg-emerald-950/20">
                  <div className="flex items-center gap-4">
                    <div
                      className="shrink-0"
                      dangerouslySetInnerHTML={{ __html: footprint.badge.svgBadge }}
                    />
                    <div>
                      <div className="font-semibold">{footprint.badge.label}</div>
                      <div className="text-xs opacity-70">{footprint.badge.description}</div>
                    </div>
                  </div>
                  <button
                    onClick={handleCopyBadgeSvg}
                    className="shrink-0 rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 px-3 py-1.5 text-xs font-medium"
                  >
                    Copy Badge SVG
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {myCredits.length > 0 && (
          <section aria-label="My credits" className="mb-8">
            <h2 className="text-lg font-semibold mb-3">My Credits</h2>
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/5 text-xs uppercase opacity-60">
                  <tr>
                    <th className="px-4 py-2 text-left">ID</th>
                    <th className="px-4 py-2 text-right">Credits</th>
                    <th className="px-4 py-2 text-right">kWh</th>
                    <th className="px-4 py-2 text-left">Vintage</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Registry</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {myCredits.map((c) => (
                    <tr key={c.id} className="border-t border-white/5 hover:bg-white/5">
                      <td className="px-4 py-2 font-mono text-xs opacity-70">{c.id.slice(0, 18)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.creditsIssued.toFixed(4)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.kwhProduced.toLocaleString()}</td>
                      <td className="px-4 py-2">{c.vintage}</td>
                      <td className={`px-4 py-2 capitalize ${STATUS_COLORS[c.status]}`}>{c.status}</td>
                      <td className="px-4 py-2 font-mono text-xs opacity-60">{c.registryRef}</td>
                      <td className="px-4 py-2">
                        {c.status === "issued" && (
                          <button
                            onClick={() => handleRetire(c.id)}
                            disabled={busy}
                            className="text-xs text-gray-400 hover:text-red-400 border border-white/10 rounded px-2 py-0.5"
                          >
                            Retire
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {listings.length > 0 && (
          <section aria-label="Marketplace">
            <h2 className="text-lg font-semibold mb-3">Marketplace</h2>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
              {listings.map((l) => (
                <div key={l.creditId} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs opacity-60 font-mono">{l.creditId.slice(0, 18)}</div>
                  <div className="text-2xl font-semibold tabular-nums mt-1">
                    {l.pricePerCredit.toFixed(2)} XLM
                  </div>
                  <div className="text-xs opacity-60 mt-0.5">per credit · {l.quantity} available</div>
                  <div className="text-xs opacity-50 mt-1">
                    Listed {new Date(l.listedAt).toLocaleDateString()}
                  </div>
                  <button
                    onClick={() => handlePurchase(l.creditId)}
                    disabled={busy || l.sellerId === address}
                    className="mt-3 w-full rounded-lg bg-green-700 text-white text-sm font-medium py-1.5 hover:bg-green-600 disabled:opacity-40"
                  >
                    {l.sellerId === address ? "Your listing" : "Purchase"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {!address && (
          <p className="text-center opacity-60 mt-8">Connect your wallet to issue or trade carbon credits.</p>
        )}
      </main>
    </>
  );
}
