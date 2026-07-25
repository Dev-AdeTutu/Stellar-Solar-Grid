"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import { SkeletonCard } from "@/components/SkeletonCard";
import { useToast } from "@/components/ToastProvider";
import { getAllMeters, type MeterData } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

/** Stellar public keys: G + 55 base32 chars (56 total) */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

type Status = "idle" | "loading";

export default function ProviderDashboardPage() {
  const { showToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const querySearch = searchParams.get("q") ?? "";

  const [meterId, setMeterId] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [search, setSearch] = useState(querySearch);

  const [meters, setMeters] = useState<MeterData[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      searchInputRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const addressInvalid =
    ownerAddress.trim().length > 0 && !isValidStellarAddress(ownerAddress.trim());

  // Sync search to URL and filter meters
  useEffect(() => {
    if (search) {
      router.push(`?q=${encodeURIComponent(search)}`, { scroll: false } as any);
    } else if (querySearch) {
      router.push("", { scroll: false } as any);
    }
  }, [search, querySearch, router]);

  const filteredMeters = meters.filter((m) => m.owner.toLowerCase().includes(search.toLowerCase()));

  const EXPLORER_BASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.includes("Test")
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

  const fetchMeters = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const allMeters = await getAllMeters();
      setMeters(allMeters);
    } catch (err: unknown) {
      console.error("Failed to fetch meters:", err);
      setFetchError(err instanceof Error ? err.message : "Failed to fetch meters");
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchMeters();
  }, [fetchMeters]);

  async function handleDeactivate(id: string) {
    setDeactivatingId(id);
    try {
      const res = await fetch(`${API}/api/meters/${id}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Deactivation failed");

      showToast({
        variant: "success",
        title: "Meter deactivated",
        description: `${id} was deactivated successfully.`,
        actionHref: `${EXPLORER_BASE}/${data.tx_hash}`,
        actionLabel: "View transaction",
      });
      fetchMeters();
    } catch (err: unknown) {
      showToast({
        variant: "error",
        title: "Deactivation failed",
        description: err instanceof Error ? err.message : "Deactivation failed",
      });
    } finally {
      setDeactivatingId(null);
    }
  }

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
      fetchMeters();
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
    <ErrorBoundary>
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
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Meter ID</label>
              <input
                type="text"
                value={meterId}
                onChange={(e) => {
                  setMeterId(e.target.value);
                  reset();
                }}
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
                onChange={(e) => {
                  setOwnerAddress(e.target.value);
                  reset();
                }}
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

        {/* Stats row */}
        <div className="w-full max-w-5xl">
          {(() => {
            const now = Date.now() / 1000;
            const activeCount = meters.filter((m) => {
              const exp = Number(m.expires_at);
              return m.active && !(exp !== Number.MAX_SAFE_INTEGER && exp > 0 && now >= exp);
            }).length;
            const inactiveCount = meters.length - activeCount;
            return (
              <div className="grid grid-cols-3 gap-4 mb-8">
                {[
                  { label: "Total Meters", value: meters.length },
                  { label: "Active", value: activeCount, color: "text-green-400" },
                  { label: "Inactive", value: inactiveCount, color: "text-red-400" },
                ].map(({ label, value, color }) => (
                  <div
                    key={label}
                    className="rounded-xl border border-white/10 bg-solar-accent px-5 py-4 text-center"
                  >
                    <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</p>
                    <p className={`text-2xl font-bold ${color ?? "text-white"}`}>
                      {fetching ? "—" : value}
                    </p>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* Meters Table */}
        <div className="w-full max-w-5xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">Registered Meters</h2>
            <button
              onClick={fetchMeters}
              disabled={fetching}
              className="text-xs text-gray-400 hover:text-solar-yellow transition flex items-center gap-1"
            >
              {fetching ? "Refreshing..." : "↻ Refresh List"}
            </button>
          </div>

          {/* Search Input — focus with "/" shortcut */}
          <div className="relative mb-4">
            <input
              ref={searchInputRef}
              type="search"
              placeholder="Search by owner address… (press / to focus)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch("");
              }}
              className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-solar-accent overflow-hidden">
            <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
              <table className="w-full text-left text-sm text-gray-300">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase tracking-wider text-gray-400">
                  <tr>
                    <th className="px-6 py-4 font-semibold">Meter ID</th>
                    <th className="px-6 py-4 font-semibold">Owner</th>
                    <th className="px-6 py-4 font-semibold">Status</th>
                    <th className="px-6 py-4 font-semibold">Plan</th>
                    <th className="px-6 py-4 font-semibold">Usage</th>
                    <th className="px-6 py-4 font-semibold">Expiry</th>
                    <th className="px-6 py-4 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {fetchError ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-red-500">
                        {fetchError}
                      </td>
                    </tr>
                  ) : fetching && meters.length === 0 ? (
                    <>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <tr key={i}>
                          <td className="px-6 py-4">
                            <SkeletonCard height={14} />
                          </td>
                          <td className="px-6 py-4">
                            <SkeletonCard height={14} />
                          </td>
                          <td className="px-6 py-4">
                            <SkeletonCard height={18} />
                          </td>
                          <td className="px-6 py-4">
                            <SkeletonCard height={14} />
                          </td>
                          <td className="px-6 py-4">
                            <SkeletonCard height={14} />
                          </td>
                          <td className="px-6 py-4">
                            <SkeletonCard height={14} />
                          </td>
                          <td className="px-6 py-4">
                            <SkeletonCard height={28} />
                          </td>
                        </tr>
                      ))}
                    </>
                  ) : filteredMeters.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                        {search ? "No meters match your search" : "No meters found."}
                      </td>
                    </tr>
                  ) : (
                    filteredMeters.map((m, i) => {
                      const expiresAt = Number(m.expires_at);
                      const isExpired =
                        expiresAt !== Number.MAX_SAFE_INTEGER &&
                        expiresAt > 0 &&
                        Date.now() / 1000 >= expiresAt;
                      const isActive = m.active && !isExpired;

                      return (
                        <tr key={i} className="hover:bg-white/[0.02] transition">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2 font-mono text-xs text-solar-yellow">
                              <span>{m.meter_id ?? "—"}</span>
                              {m.meter_id && (
                                <button
                                  aria-label={`Copy meter ID ${m.meter_id}`}
                                  onClick={() => {
                                    navigator.clipboard.writeText(m.meter_id!);
                                    showToast({ variant: "success", title: "Meter ID copied" });
                                  }}
                                  className="text-gray-400 hover:text-solar-yellow transition shrink-0"
                                >
                                  ⧉
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 font-mono text-xs">
                            {m.owner.slice(0, 8)}...{m.owner.slice(-8)}
                          </td>
                          <td className="px-6 py-4">
                            <MeterStatusBadge active={m.active} expiresAt={expiresAt} />
                          </td>
                          <td className="px-6 py-4 text-xs font-medium">{m.plan}</td>
                          <td className="px-6 py-4 text-xs">
                            {Number(m.units_used) / 1000} <span className="text-gray-500">kWh</span>
                          </td>
                          <td className="px-6 py-4 text-xs text-gray-400">
                            {expiresAt === Number.MAX_SAFE_INTEGER
                              ? "Never"
                              : new Date(expiresAt * 1000).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4">
                            {isActive && (
                              <button
                                onClick={() => handleDeactivate(String(m.owner).slice(0, 12))}
                                disabled={deactivatingId !== null}
                                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
                              >
                                {deactivatingId ? "Deactivating…" : "Deactivate"}
                              </button>
                            )}
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
    </ErrorBoundary>
  );
}
