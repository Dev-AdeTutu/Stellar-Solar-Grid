"use client";

import { useState, useEffect, useCallback } from "react";
import Navbar from "@/components/Navbar";
import { useToast } from "@/components/ToastProvider";
import { getAllMeters, type MeterData } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";

const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

/** Stellar public keys: G + 55 base32 chars (56 total) */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

type Status = "idle" | "loading";

export default function ProviderDashboardPage() {
  const { showToast } = useToast();
  const [meterId, setMeterId] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  
  const [meters, setMeters] = useState<MeterData[]>([]);
  const [fetching, setFetching] = useState(false);

  const addressInvalid = ownerAddress.length > 0 && !isValidStellarAddress(ownerAddress);

  const EXPLORER_BASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.includes("Test")
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

  const fetchMeters = useCallback(async () => {
    setFetching(true);
    try {
      const allMeters = await getAllMeters();
      setMeters(allMeters);
    } catch (err: unknown) {
      console.error("Failed to fetch meters:", err);
      // Don't show toast on initial load to avoid noise, but maybe we should
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchMeters();
  }, [fetchMeters]);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidStellarAddress(ownerAddress.trim())) {
      showToast({
        variant: "error",
        title: "Registration failed",
        description: "Invalid Stellar address. Must start with G and be 56 characters.",
      });
      return;
    }

    setStatus("loading");

    try {
      const res = await fetch(`${API}/api/meters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meter_id: meterId.trim(),
          owner: ownerAddress.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Registration failed");

      showToast({
        variant: "success",
        title: "Meter registered",
        description: `${meterId.trim()} was registered successfully.`,
        actionHref: `${EXPLORER_BASE}/${data.hash}`,
        actionLabel: "View transaction",
      });
      setMeterId("");
      setOwnerAddress("");
      fetchMeters(); // Refresh list
    } catch (err: unknown) {
      showToast({
        variant: "error",
        title: "Registration failed",
        description: err instanceof Error ? err.message : "Registration failed",
      });
    } finally {
      setStatus("idle");
    }
  }

  function reset() {
    setStatus("idle");
  }

  return (
    <>
      <Navbar />
      <main className="min-h-screen flex flex-col items-center px-4 py-8 sm:py-16 gap-12">
        <div className="w-full max-w-md">
          <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow mb-2">
            Provider Dashboard
          </h1>
          <p className="text-gray-400 text-sm mb-6">
            Register new smart meters on the Stellar blockchain.
          </p>

          <form
            onSubmit={handleRegister}
            className="rounded-xl border border-white/10 bg-solar-accent p-6 space-y-5"
          >
            {/* Meter ID */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Meter ID
              </label>
              <input
                type="text"
                value={meterId}
                onChange={(e) => { setMeterId(e.target.value); reset(); }}
                placeholder="e.g. METER5"
                required
                disabled={status === "loading"}
                className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
              />
            </div>

            {/* Owner Address */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Owner Stellar Address
              </label>
              <input
                type="text"
                value={ownerAddress}
                onChange={(e) => { setOwnerAddress(e.target.value); reset(); }}
                placeholder="G…"
                required
                disabled={status === "loading"}
                aria-describedby={addressInvalid ? "address-hint" : undefined}
                className={`w-full rounded-lg border px-4 py-2.5 text-sm text-white placeholder-gray-600 bg-solar-dark focus:outline-none transition ${
                  addressInvalid
                    ? "border-red-500/60 focus:border-red-500"
                    : "border-white/10 focus:border-solar-yellow"
                }`}
              />
              {addressInvalid && (
                <p id="address-hint" className="mt-1 text-xs text-red-400">
                  Must be a valid Stellar address (G…, 56 characters)
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={status === "loading" || addressInvalid}
              className="w-full rounded-lg bg-solar-yellow py-3.5 text-base font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {status === "loading" ? "Registering…" : "Register Meter"}
            </button>
          </form>
        </div>

        {/* Meters Table */}
        <div className="w-full max-w-5xl">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-white">Registered Meters</h2>
            <button 
              onClick={fetchMeters}
              disabled={fetching}
              className="text-xs text-gray-400 hover:text-solar-yellow transition flex items-center gap-1"
            >
              {fetching ? "Refreshing..." : "↻ Refresh List"}
            </button>
          </div>

          <div className="rounded-xl border border-white/10 bg-solar-accent overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-gray-300">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase tracking-wider text-gray-400">
                  <tr>
                    <th className="px-6 py-4 font-semibold">Owner</th>
                    <th className="px-6 py-4 font-semibold">Status</th>
                    <th className="px-6 py-4 font-semibold">Plan</th>
                    <th className="px-6 py-4 font-semibold">Usage</th>
                    <th className="px-6 py-4 font-semibold">Expiry</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {meters.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                        {fetching ? "Loading meters..." : "No meters found."}
                      </td>
                    </tr>
                  ) : (
                    meters.map((m, i) => {
                      const expiresAt = Number(m.expires_at);
                      const isExpired = expiresAt !== Number.MAX_SAFE_INTEGER && expiresAt > 0 && Date.now() / 1000 >= expiresAt;
                      
                      return (
                        <tr key={i} className="hover:bg-white/[0.02] transition">
                          <td className="px-6 py-4 font-mono text-xs">
                            {m.owner.slice(0, 8)}...{m.owner.slice(-8)}
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                              m.active && !isExpired ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
                            }`}>
                              <span className={`h-1 w-1 rounded-full ${m.active && !isExpired ? "bg-green-500" : "bg-red-500"}`} />
                              {m.active && !isExpired ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-xs font-medium">{m.plan}</td>
                          <td className="px-6 py-4 text-xs">
                            {Number(m.units_used) / 1000} <span className="text-gray-500">kWh</span>
                          </td>
                          <td className="px-6 py-4 text-xs text-gray-400">
                            {expiresAt === Number.MAX_SAFE_INTEGER ? "Never" : new Date(expiresAt * 1000).toLocaleDateString()}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
