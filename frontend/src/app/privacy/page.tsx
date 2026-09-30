"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";
import { getSmartHomeSession } from "@/lib/smartHomeClient";
import { useWalletStore } from "@/store/walletStore";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const SCOPES = ["usage", "billing", "meter", "location"] as const;

type Settings = { sharingLevel: "none" | "aggregate" | "full"; anonymize: boolean; allowAnalytics: boolean; allowResearch: boolean };
type Grant = { id: string; thirdParty: string; scopes: string[]; expiresAt: string | null };
type Dashboard = {
  settings: Settings;
  grants: Grant[];
  usage: { total: number; byActor: Record<string, number>; byScope: Record<string, number>; recent: { at: string; actor: string; action: string; scopes: string[] }[] };
};

export default function PrivacyPage() {
  const address = useWalletStore((state) => state.address);
  const signTransaction = useWalletStore((state) => state.signTransaction);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [meterId, setMeterId] = useState("");
  const [thirdParty, setThirdParty] = useState("");
  const [scopes, setScopes] = useState<string[]>(["usage"]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      if (!address) throw new Error("Connect a wallet to manage your privacy.");
      const token = await getSmartHomeSession(address, signTransaction);
      const res = await fetch(`${API}/api/privacy${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
      return res.status === 204 ? undefined : res.json();
    },
    [address, signTransaction],
  );

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      setError(null);
      await fn();
      setDashboard(await call("/dashboard"));
      if (success) setMessage(success);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  useEffect(() => {
    if (address) call("/dashboard").then(setDashboard).catch((cause) => setError((cause as Error).message));
  }, [address, call]);

  const updateSetting = (patch: Partial<Settings>) =>
    run(() => call("/settings", { method: "PUT", body: JSON.stringify(patch) }), "Settings saved");

  const addGrant = (e: FormEvent) => {
    e.preventDefault();
    run(() => call("/grants", { method: "POST", body: JSON.stringify({ thirdParty, scopes }) }), "Access granted").then(() => setThirdParty(""));
  };

  const meterQuery = meterId.trim() ? `?meterId=${encodeURIComponent(meterId.trim())}` : "";

  const exportData = () =>
    run(async () => {
      const data = await call(`/export${meterQuery}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "solargrid-data-export.json" });
      a.click();
      URL.revokeObjectURL(url);
    }, "Data exported");

  const deleteData = () =>
    run(() => call(`/data${meterQuery}`, { method: "DELETE" }), "All your data has been deleted").then(() => setConfirmDelete(false));

  const s = dashboard?.settings;

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold mb-1">Privacy Dashboard</h1>
          <p className="opacity-60 text-sm">Control how your energy data is shared, anonymized, exported and deleted.</p>
        </div>
        {!address && <p className="opacity-70">Connect a wallet to manage your privacy settings.</p>}
        {error && <p className="text-red-400">{error}</p>}
        {message && <p className="text-green-400">{message}</p>}

        {s && (
          <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <h2 className="text-lg font-semibold">Sharing settings</h2>
            <label className="flex items-center gap-3 text-sm">
              Data sharing level
              <select className="bg-black/40 rounded px-2 py-1" value={s.sharingLevel} onChange={(e) => updateSetting({ sharingLevel: e.target.value as Settings["sharingLevel"] })}>
                <option value="none">None — no third-party sharing</option>
                <option value="aggregate">Aggregate — grid-level statistics only</option>
                <option value="full">Full — granted third parties see detailed data</option>
              </select>
            </label>
            {(["anonymize", "allowAnalytics", "allowResearch"] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s[key]} onChange={(e) => updateSetting({ [key]: e.target.checked })} />
                {{ anonymize: "Anonymize shared data (remove personal information)", allowAnalytics: "Allow usage analytics", allowResearch: "Allow use in energy research" }[key]}
              </label>
            ))}
          </section>
        )}

        {dashboard && (
          <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <h2 className="text-lg font-semibold">Third-party access</h2>
            {dashboard.grants.length === 0 && <p className="opacity-60 text-sm">No third parties have access.</p>}
            <ul className="space-y-2">
              {dashboard.grants.map((g) => (
                <li key={g.id} className="flex items-center justify-between text-sm">
                  <span>
                    <strong>{g.thirdParty}</strong> — {g.scopes.join(", ")}
                    {g.expiresAt && <span className="opacity-60"> (until {new Date(g.expiresAt).toLocaleDateString()})</span>}
                  </span>
                  <button className="text-red-400 hover:underline" onClick={() => run(() => call(`/grants/${g.id}`, { method: "DELETE" }), "Access revoked")}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={addGrant} className="flex flex-wrap items-center gap-3 text-sm">
              <input className="bg-black/40 rounded px-2 py-1" placeholder="Third party name" value={thirdParty} onChange={(e) => setThirdParty(e.target.value)} required />
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) => setScopes((prev) => (e.target.checked ? [...prev, scope] : prev.filter((x) => x !== scope)))}
                  />
                  {scope}
                </label>
              ))}
              <button type="submit" disabled={!scopes.length} className="rounded bg-yellow-500/80 px-3 py-1 text-black disabled:opacity-50">Grant access</button>
            </form>
          </section>
        )}

        {dashboard && (
          <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <h2 className="text-lg font-semibold">Data usage</h2>
            <p className="text-sm opacity-70">{dashboard.usage.total} recorded data access event(s).</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(dashboard.usage.byScope).map(([scope, n]) => (
                <span key={scope} className="rounded-full border border-white/20 px-2 py-0.5">{scope}: {n}</span>
              ))}
            </div>
            <ul className="text-sm space-y-1">
              {dashboard.usage.recent.map((u) => (
                <li key={u.at + u.action} className="opacity-80">
                  {new Date(u.at).toLocaleString()} — {u.actor === address ? "You" : u.actor} · {u.action} ({u.scopes.join(", ")})
                </li>
              ))}
            </ul>
          </section>
        )}

        {address && (
          <section className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <h2 className="text-lg font-semibold">Export or delete your data</h2>
            <input className="bg-black/40 rounded px-2 py-1 text-sm" placeholder="Meter ID (optional)" value={meterId} onChange={(e) => setMeterId(e.target.value)} />
            <div className="flex flex-wrap gap-3">
              <button className="rounded bg-white/10 px-3 py-1 text-sm" onClick={exportData}>Export all data</button>
              {!confirmDelete ? (
                <button className="rounded bg-red-600/80 px-3 py-1 text-sm" onClick={() => setConfirmDelete(true)}>Delete all data</button>
              ) : (
                <>
                  <span className="text-sm text-red-300">This cannot be undone.</span>
                  <button className="rounded bg-red-600 px-3 py-1 text-sm" onClick={deleteData}>Confirm delete</button>
                  <button className="rounded bg-white/10 px-3 py-1 text-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </>
              )}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
