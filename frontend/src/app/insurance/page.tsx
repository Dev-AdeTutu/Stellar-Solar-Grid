"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { usePaymentStore } from "@/store/paymentStore";

export interface InsurancePlanOption {
  id: string;
  name: string;
  provider: string;
  providerAddress: string;
  premium: number;
  coverage: number;
  durationDays: number;
  hazardsCovered: string[];
}

export interface PolicyRecord {
  meterId: string;
  provider: string;
  premium: number;
  coverage: number;
  expiry: number;
  active: boolean;
}

export interface ClaimRecord {
  id: number;
  meterId: string;
  amount: number;
  reason: string;
  status: "Pending" | "Approved" | "Rejected";
  filedAt: string;
}

const MARKETPLACE_PLANS: InsurancePlanOption[] = [
  {
    id: "basic-shield",
    name: "Lightning & Surge Shield",
    provider: "SolarGuard Mutual",
    providerAddress: "GSOLARGUARD111111111111111111111111111111111111111111111",
    premium: 5,
    coverage: 250,
    durationDays: 30,
    hazardsCovered: ["Lightning Strike", "Grid Surge"],
  },
  {
    id: "total-protect",
    name: "Total Meter Protection",
    provider: "GridSafe Underwriters",
    providerAddress: "GGRIDSAFE22222222222222222222222222222222222222222222222",
    premium: 15,
    coverage: 1000,
    durationDays: 90,
    hazardsCovered: ["Lightning Strike", "Theft", "Accidental Damage", "Weather Flooding"],
  },
  {
    id: "pro-annual",
    name: "Commercial Microgrid Cover",
    provider: "Helios Reinsurance",
    providerAddress: "GHELIOSRE33333333333333333333333333333333333333333333333",
    premium: 45,
    coverage: 5000,
    durationDays: 365,
    hazardsCovered: ["All-Risk Hardware", "Theft", "Lightning", "Vandalism"],
  },
];

export default function InsuranceMarketplacePage() {
  const { address } = useWalletStore();
  const defaultMeterId = usePaymentStore((s) => s.meterId);
  const [meterId, setMeterId] = useState(defaultMeterId || "METER-001");
  const [policies, setPolicies] = useState<Record<string, PolicyRecord>>({});
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [claimAmount, setClaimAmount] = useState("100");
  const [claimReason, setClaimReason] = useState("Lightning strike surge damage");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const activePolicy = policies[meterId];

  const handlePurchase = (plan: InsurancePlanOption) => {
    const expiry = Math.floor(Date.now() / 1000) + plan.durationDays * 86400;
    const newPolicy: PolicyRecord = {
      meterId,
      provider: plan.provider,
      premium: plan.premium,
      coverage: plan.coverage,
      expiry,
      active: true,
    };
    setPolicies((prev) => ({ ...prev, [meterId]: newPolicy }));
    setStatusMessage(
      `Purchased "${plan.name}" for ${meterId} (Coverage: ${plan.coverage} USDC, Premium: ${plan.premium} USDC)`,
    );
  };

  const handleFileClaim = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePolicy || !activePolicy.active) {
      setStatusMessage("No active insurance policy found for this meter.");
      return;
    }
    const amt = Number(claimAmount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > activePolicy.coverage) {
      setStatusMessage(`Claim amount must be between 1 and ${activePolicy.coverage} USDC.`);
      return;
    }
    const nextClaim: ClaimRecord = {
      id: claims.length + 1,
      meterId,
      amount: amt,
      reason: claimReason,
      status: "Pending",
      filedAt: new Date().toISOString(),
    };
    setClaims((prev) => [nextClaim, ...prev]);
    setStatusMessage(`Insurance claim #${nextClaim.id} filed for ${meterId}.`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-amber-400">Meter Insurance Marketplace</h1>
          <p className="mt-2 text-slate-400">
            Protect smart meters against lightning, theft, and accidental damage with on-chain policies.
          </p>
        </header>

        <section className="mb-8 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <label htmlFor="meter-id-input" className="block text-sm font-medium text-slate-300">
                Target Meter ID
              </label>
              <input
                id="meter-id-input"
                type="text"
                value={meterId}
                onChange={(e) => setMeterId(e.target.value)}
                className="mt-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
              />
            </div>
            <div>
              <span className="text-sm text-slate-400">Insurance Status: </span>
              {activePolicy?.active ? (
                <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-sm font-semibold text-emerald-300">
                  Insured ({activePolicy.provider} — up to {activePolicy.coverage} USDC)
                </span>
              ) : (
                <span className="rounded-full bg-rose-500/20 px-3 py-1 text-sm font-semibold text-rose-300">
                  Uninsured
                </span>
              )}
            </div>
          </div>
          {statusMessage && (
            <p role="status" className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">
              {statusMessage}
            </p>
          )}
        </section>

        <section aria-label="Insurance Plans" className="mb-10 grid gap-6 md:grid-cols-3">
          {MARKETPLACE_PLANS.map((plan) => (
            <div
              key={plan.id}
              className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900 p-6"
            >
              <div>
                <h2 className="text-xl font-semibold text-white">{plan.name}</h2>
                <p className="text-sm text-slate-400">{plan.provider}</p>
                <div className="my-4">
                  <span className="text-2xl font-bold text-amber-400">{plan.premium} USDC</span>
                  <span className="text-sm text-slate-400"> / {plan.durationDays} days</span>
                </div>
                <p className="text-sm text-slate-300">
                  Max Coverage: <strong>{plan.coverage} USDC</strong>
                </p>
                <ul className="mt-3 space-y-1 text-xs text-slate-400">
                  {plan.hazardsCovered.map((hazard) => (
                    <li key={hazard}>• {hazard}</li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                onClick={() => handlePurchase(plan)}
                className="mt-6 w-full rounded-lg bg-amber-500 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-400"
              >
                Purchase Policy
              </button>
            </div>
          ))}
        </section>

        <section className="grid gap-8 md:grid-cols-2">
          <form
            onSubmit={handleFileClaim}
            className="rounded-xl border border-slate-800 bg-slate-900 p-6"
          >
            <h2 className="mb-4 text-xl font-semibold">File an Insurance Claim</h2>
            <div className="mb-4">
              <label htmlFor="claim-amount" className="block text-sm text-slate-300">
                Claim Amount (USDC)
              </label>
              <input
                id="claim-amount"
                type="number"
                value={claimAmount}
                onChange={(e) => setClaimAmount(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
              />
            </div>
            <div className="mb-4">
              <label htmlFor="claim-reason" className="block text-sm text-slate-300">
                Incident Reason
              </label>
              <input
                id="claim-reason"
                type="text"
                value={claimReason}
                onChange={(e) => setClaimReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white"
              />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-sky-500 px-4 py-2 font-semibold text-slate-950 hover:bg-sky-400"
            >
              Submit Claim
            </button>
          </form>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="mb-4 text-xl font-semibold">Claims History ({claims.length})</h2>
            {claims.length === 0 ? (
              <p className="text-sm text-slate-400">No claims filed yet.</p>
            ) : (
              <ul className="space-y-3">
                {claims.map((claim) => (
                  <li
                    key={claim.id}
                    className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-sm"
                  >
                    <div className="flex justify-between font-medium">
                      <span>
                        Claim #{claim.id} — {claim.meterId}
                      </span>
                      <span className="text-amber-400">{claim.amount} USDC</span>
                    </div>
                    <p className="text-slate-400">{claim.reason}</p>
                    <span className="text-xs text-sky-400">Status: {claim.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
