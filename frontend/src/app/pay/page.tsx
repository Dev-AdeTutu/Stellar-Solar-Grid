"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import OfflinePaymentModal from "@/components/OfflinePaymentModal";
import { useToast } from "@/components/ToastProvider";
import { useWalletStore } from "@/store/walletStore";
import { usePaymentStore } from "@/store/paymentStore";
import { useOffline } from "@/hooks/useOffline";
import { makePayment } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";

type Plan = "Daily" | "Weekly" | "Usage";
type Status = "idle" | "loading";

const PLANS: { value: Plan; label: string; desc: string }[] = [
  { value: "Daily",  label: "Daily",       desc: "Billed every 24 hours" },
  { value: "Weekly", label: "Weekly",      desc: "Billed every 7 days"   },
  { value: "Usage",  label: "Usage-Based", desc: "Pay per kWh consumed"  },
];

export default function PayPage() {
  const { address, connect } = useWalletStore();
  const { meterId, plan, setMeterId, setPlan } = usePaymentStore();
  const { showToast } = useToast();
  const isOffline = useOffline();

  const [amount, setAmount]       = useState("");
  const [status, setStatus]       = useState<Status>("idle");
  const [showSmsModal, setShowSmsModal] = useState(false);

  const EXPLORER_BASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.includes("Test")
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return;

    const amountNum = parseFloat(amount);
    if (!meterId.trim() || isNaN(amountNum) || amountNum <= 0) return;

    setStatus("loading");

    try {
      const hash = await makePayment(address, meterId.trim(), amountNum, plan);
      showToast({
        variant: "success",
        title: "Payment successful",
        description: `${meterId.trim()} was topped up with ${amountNum.toFixed(2)} XLM.`,
        actionHref: `${EXPLORER_BASE}/${hash}`,
        actionLabel: "View transaction",
      });
      setAmount("");
    } catch (err: unknown) {
      const friendly = parseWalletError(err);
      showToast({
        variant: "error",
        title:
          friendly === "Transaction cancelled by user."
            ? "Payment cancelled"
            : "Payment failed",
        description: friendly,
      });
    } finally {
      setStatus("idle");
    }
  }

  return (
    <>
      <Navbar />

      {/* ── Offline banner — always visible when offline ── */}
      {isOffline && (
        <div className="bg-yellow-900/30 border-b border-yellow-500/30 px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-yellow-300 text-xs">
            <span>📵</span>
            <span>You&apos;re offline — blockchain payments unavailable.</span>
          </div>
          <button
            onClick={() => setShowSmsModal(true)}
            className="shrink-0 rounded-lg bg-solar-yellow px-3 py-1.5 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
          >
            Pay via SMS
          </button>
        </div>
      )}

      <main className="min-h-screen flex items-start justify-center px-4 py-8 sm:py-16">
        <div className="w-full max-w-md">
          <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow mb-2">
            Make a Payment
          </h1>
          <p className="text-gray-400 text-sm mb-6">
            Top up your meter balance on the Stellar blockchain.
          </p>

          {/* ── SMS fallback card — shown when offline ── */}
          {isOffline && (
            <div className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-900/10 p-5">
              <div className="flex items-start gap-3">
                <span className="text-2xl mt-0.5">📱</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-yellow-300 mb-1">
                    No internet connection
                  </p>
                  <p className="text-xs text-gray-400 mb-3">
                    You can still top up your meter by sending an SMS. No smartphone or data required.
                  </p>
                  <button
                    onClick={() => setShowSmsModal(true)}
                    className="rounded-lg bg-solar-yellow px-4 py-2.5 text-sm font-semibold text-solar-dark hover:opacity-90 transition"
                  >
                    View SMS Payment Instructions
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Online: SMS option as secondary CTA ── */}
          {!isOffline && (
            <div className="mb-5 flex items-center justify-between rounded-lg border border-white/10 bg-solar-accent px-4 py-3">
              <span className="text-xs text-gray-400">Low connectivity? Use SMS instead.</span>
              <button
                onClick={() => setShowSmsModal(true)}
                className="text-xs text-solar-yellow underline underline-offset-2 hover:opacity-80 transition"
              >
                SMS guide ↗
              </button>
            </div>
          )}

          {!address ? (
            <div className="rounded-xl border border-white/10 bg-solar-accent p-8 text-center">
              <p className="text-gray-400 mb-4">Connect your wallet to make a payment.</p>
              <button
                onClick={connect}
                disabled={isOffline}
                className="rounded-lg bg-solar-yellow px-6 py-2.5 font-semibold text-solar-dark hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                Connect Wallet
              </button>
              {isOffline && (
                <p className="mt-2 text-xs text-gray-500">
                  Wallet connection requires internet.
                </p>
              )}
            </div>
          ) : (
            <form
              onSubmit={handlePay}
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
                  onChange={(e) => setMeterId(e.target.value)}
                  placeholder="e.g. METER1"
                  required
                  className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
                />
              </div>

              {/* Amount */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Amount (XLM)
                </label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  min="0.0000001"
                  step="any"
                  required
                  className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
                />
              </div>

              {/* Plan */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Billing Plan
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {PLANS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPlan(p.value)}
                      className={`rounded-lg border px-3 py-3 text-left transition ${
                        plan === p.value
                          ? "border-solar-yellow bg-solar-yellow/10 text-solar-yellow"
                          : "border-white/10 text-gray-400 hover:border-white/30"
                      }`}
                    >
                      <div className="text-sm font-semibold">{p.label}</div>
                      <div className="text-xs opacity-70 mt-0.5">{p.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={status === "loading" || isOffline}
                className="w-full rounded-lg bg-solar-yellow py-3.5 text-base font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {isOffline
                  ? "Unavailable offline"
                  : status === "loading"
                  ? "Waiting for wallet…"
                  : "Pay Now"}
              </button>

              {isOffline && (
                <p className="text-center text-xs text-gray-500">
                  No internet.{" "}
                  <button
                    type="button"
                    onClick={() => setShowSmsModal(true)}
                    className="text-solar-yellow underline underline-offset-2"
                  >
                    Use SMS payment instead.
                  </button>
                </p>
              )}
            </form>
          )}
        </div>
      </main>

      {/* ── SMS modal ── */}
      {showSmsModal && (
        <OfflinePaymentModal
          meterId={meterId}
          onClose={() => setShowSmsModal(false)}
        />
      )}
    </>
  );
}
