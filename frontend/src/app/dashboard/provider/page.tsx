"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Stellar public keys: G + 55 base32 chars (56 total) */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

type Status = "idle" | "loading" | "success" | "error";

export default function ProviderDashboardPage() {
  const [meterId, setMeterId] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState("");

  const addressInvalid = ownerAddress.length > 0 && !isValidStellarAddress(ownerAddress);

  const EXPLORER_BASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.includes("Test")
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidStellarAddress(ownerAddress.trim())) {
      setStatus("error");
      setMessage("Invalid Stellar address. Must start with G and be 56 characters.");
      return;
    }

    setStatus("loading");
    setMessage("");
    setTxHash("");

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

      setTxHash(data.hash);
      setStatus("success");
      setMessage("Meter registered successfully.");
      setMeterId("");
      setOwnerAddress("");
    } catch (err: unknown) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Registration failed");
    }
  }

  function reset() {
    setStatus("idle");
    setMessage("");
    setTxHash("");
  }

  return (
    <>
      <Navbar />
      <main className="min-h-screen flex items-start justify-center px-4 py-8 sm:py-16">
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

            {/* Feedback */}
            {status === "error" && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-900/20 px-4 py-3 text-sm text-red-400">
                <span>✕</span>
                <span>{message}</span>
              </div>
            )}
            {status === "success" && (
              <div className="rounded-lg border border-green-500/40 bg-green-900/20 px-4 py-3 text-sm text-green-400">
                <div className="font-semibold mb-1">✓ {message}</div>
                {txHash && (
                  <a
                    href={`${EXPLORER_BASE}/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 underline underline-offset-2 font-mono text-xs hover:text-blue-300 transition"
                  >
                    {txHash.slice(0, 10)}…{txHash.slice(-8)} ↗
                  </a>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={status === "loading" || addressInvalid}
              className="w-full rounded-lg bg-solar-yellow py-3.5 text-base font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {status === "loading" ? "Registering…" : "Register Meter"}
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
