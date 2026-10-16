"use client";

/**
 * Meter lifespan & depreciation (#998): look up a meter's installation date,
 * age, remaining lifespan and depreciation, or register a new meter asset.
 */
import { useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type AssetInfo = {
  meterId: string;
  installedAt: string;
  expectedLifespanYears: number;
  ageYears: number;
  remainingYears: number;
  depreciationPercent: number;
  bookValueStroops: number | null;
  endOfLifeAt: string;
  nearEndOfLife: boolean;
};

const STROOPS_PER_XLM = 10_000_000;

export default function AssetInfoPage() {
  const [meterId, setMeterId] = useState("");
  const [info, setInfo] = useState<AssetInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifespan, setLifespan] = useState("15");

  async function fetchInfo() {
    setError(null);
    setInfo(null);
    const res = await fetch(`${API}/api/meters/${encodeURIComponent(meterId.trim())}/asset-info`);
    const body = await res.json();
    if (!res.ok) return setError(body.error ?? `HTTP ${res.status}`);
    setInfo(body);
  }

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    await fetchInfo();
  }

  async function register() {
    setError(null);
    const res = await fetch(`${API}/api/meters/${encodeURIComponent(meterId.trim())}/asset-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedLifespanYears: Number(lifespan) || undefined }),
    });
    const body = await res.json();
    if (!res.ok) return setError(body.error ?? `HTTP ${res.status}`);
    await fetchInfo();
  }

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-lg mx-auto">
        <h1 className="text-2xl font-bold mb-1">Meter Asset Info</h1>
        <p className="text-sm opacity-70 mb-4">Installation date, age, remaining lifespan and depreciation.</p>

        <form onSubmit={lookup} className="flex gap-2 mb-4">
          <input
            aria-label="Meter ID"
            className="flex-1 rounded border px-2 py-1.5 text-sm bg-transparent"
            placeholder="Meter ID"
            value={meterId}
            onChange={(e) => setMeterId(e.target.value)}
            required
          />
          <button type="submit" className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white">
            Look up
          </button>
        </form>

        {error && (
          <div className="mb-4 text-sm">
            <p className="text-red-500">{error}</p>
            {error.toLowerCase().includes("no asset info") && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  aria-label="Expected lifespan (years)"
                  className="w-24 rounded border px-2 py-1 text-sm bg-transparent"
                  value={lifespan}
                  onChange={(e) => setLifespan(e.target.value)}
                />
                <button className="rounded border px-3 py-1 text-sm" onClick={register}>
                  Register this meter now, {lifespan}y lifespan
                </button>
              </div>
            )}
          </div>
        )}

        {info && (
          <dl className="grid grid-cols-2 gap-2 text-sm rounded border border-white/10 p-4">
            <dt className="opacity-70">Installed</dt>
            <dd>{new Date(info.installedAt).toLocaleDateString()}</dd>
            <dt className="opacity-70">Age</dt>
            <dd>{info.ageYears.toFixed(1)} years</dd>
            <dt className="opacity-70">Expected lifespan</dt>
            <dd>{info.expectedLifespanYears} years</dd>
            <dt className="opacity-70">Remaining</dt>
            <dd className={info.nearEndOfLife ? "text-amber-500 font-medium" : ""}>
              {info.remainingYears.toFixed(1)} years {info.nearEndOfLife ? "⚠️ near end of life" : ""}
            </dd>
            <dt className="opacity-70">Depreciation</dt>
            <dd>{info.depreciationPercent.toFixed(1)}%</dd>
            {info.bookValueStroops !== null && (
              <>
                <dt className="opacity-70">Book value</dt>
                <dd>{(info.bookValueStroops / STROOPS_PER_XLM).toLocaleString()} XLM</dd>
              </>
            )}
            <dt className="opacity-70">End of life</dt>
            <dd>{new Date(info.endOfLifeAt).toLocaleDateString()}</dd>
          </dl>
        )}
      </main>
    </>
  );
}
