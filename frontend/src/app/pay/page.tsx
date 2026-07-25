"use client";

import { useState, useEffect } from "react";
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
  { value: "Daily", label: "Daily", desc: "Billed every 24 hours" },
  { value: "Weekly", label: "Weekly", desc: "Billed every 7 days" },
  { value: "Usage", label: "Usage-Based", desc: "Pay per kWh consumed" },
];

const PLAN_AMOUNT_HINTS: Record<Plan, string> = {
  Daily: "Suggested: 10 XLM/day",
  Weekly: "Suggested: 50 XLM/week",
  Usage: "Amount (billed per kWh consumed)",
};

export default function PayPage() {
  const { address, connect } = useWalletStore();
  const { meterId, plan, setMeterId, setPlan } = usePaymentStore();
  const { showToast } = useToast();
  const isOffline = useOffline();

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [showSmsModal, setShowSmsModal] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [xlmRate, setXlmRate] = useState<number | null>(null);
  const [currency, setCurrency] = useState("NGN");
  const [txHash, setTxHash] = useState<string | null>(null);

  // Load currency preference from localStorage
  useEffect(() => {
    const savedCurrency = localStorage.getItem("preferredCurrency");
    if (savedCurrency) {
      setCurrency(savedCurrency);
    }
  }, []);

  // Fetch XLM exchange rate
  useEffect(() => {
    const fetchRate = async () => {
      try {
        const currencyCode = currency.toLowerCase();
        const response = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=${currencyCode}`
        );
        const data = await response.json();
        setXlmRate(data.stellar[currencyCode]);
      } catch (error) {
        console.error("Failed to fetch exchange rate:", error);
        setXlmRate(null);
      }
    };

    fetchRate();
    // Refresh rate every 5 minutes
    const interval = setInterval(fetchRate, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [currency]);

  const handleCurrencyChange = (newCurrency: string) => {
    setCurrency(newCurrency);
    localStorage.setItem("preferredCurrency", newCurrency);
  };

  const EXPLORER_BASE = import.meta.env.VITE_NETWORK_PASSPHRASE?.includes("Test")
    ? "https://stellar.expert/explorer/testnet/tx"
    : "https://stellar.expert/explorer/public/tx";

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();
    if (isOffline || !address) return;

    const amountNum = parseFloat(amount);
    if (!meterId.trim() || isNaN(amountNum) || amountNum <= 0) return;

    // Show confirmation modal instead of submitting directly
    setShowConfirm(true);
  }

  async function confirmPayment() {
    if (isOffline) {
      showToast({
        variant: "error",
        title: "Offline",
        description: "Blockchain payments unavailable offline.",
      });
      setShowSmsModal(true);
      return;
    }
    if (!address) return;
    setShowConfirm(false);
    setStatus("loading");
    setTxHash(null);

    try {
      const hash = await makePayment(address, meterId.trim(), parseFloat(amount), plan);
      showToast({
        variant: "success",
        title: "Payment successful",
        description: `${meterId.trim()} topped up · tx ${hash.slice(0, 8)}…`,
        actionHref: `${EXPLORER_BASE}/${hash}`,
        actionLabel: "View transaction",
      });
      setAmount("");
      setTxHash(hash);
    } catch (err: unknown) {
      const friendly = parseWalletError(err);
      showToast({
        variant: "error",
        title:
          friendly === "Transaction cancelled by user." ? "Payment cancelled" : "Payment failed",
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
          <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow mb-2">Make a Payment</h1>
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
                    You can still top up your meter by sending an SMS. No smartphone or data
                    required.
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
                <p className="mt-2 text-xs text-gray-500">Wallet connection requires internet.</p>
              )}
            </div>
          ) : (
            <>
              {txHash && (
                <div className="mb-6 rounded-xl border border-green-600/40 bg-green-950/40 p-5">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl mt-0.5">✅</span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-green-400 mb-1">
                        Payment successful!
                      </p>
                      <p className="text-xs text-gray-400 mb-3">
                        Your transaction has been submitted to the Stellar network.
                      </p>
                      <a
                        href={`${EXPLORER_BASE}/${txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-solar-yellow underline underline-offset-2 hover:opacity-85 transition break-all font-mono"
                      >
                        View on Stellar Expert: {txHash.slice(0, 12)}...
                      </a>
                    </div>
                  </div>
                </div>
              )}
              <form
                onSubmit={handlePay}
                className="rounded-xl border border-white/10 bg-solar-accent p-6 space-y-5"
              >
                {/* Meter ID */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">Meter ID</label>
                  <input
                    type="text"
                    value={meterId}
                    onChange={(e) => { setMeterId(e.target.value); setTxHash(null); }}
                    placeholder="e.g. METER1"
                    required
                    className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
                  />
                </div>

                {/* Plan */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Billing Plan</label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {PLANS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => { setPlan(p.value); setTxHash(null); }}
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

                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Amount (XLM)
                  </label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => { setAmount(e.target.value); setTxHash(null); }}
                    placeholder="0.00"
                    min="0.0000001"
                    step="any"
                    required
                    className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
                  />
                  <p className="mt-1.5 text-xs text-gray-500">{PLAN_AMOUNT_HINTS[plan]}</p>
                  {xlmRate && amount && (
                    <div className="mt-2 flex items-center justify-between">
                      <p className="text-xs text-gray-400">
                        ≈ {(parseFloat(amount) * xlmRate).toLocaleString('en-NG', {
                          style: 'currency',
                          currency: currency
                        })}
                      </p>
                      <select
                        value={currency}
                        onChange={(e) => handleCurrencyChange(e.target.value)}
                        className="text-xs bg-solar-dark border border-white/10 rounded px-2 py-1 text-gray-300"
                      >
                        <option value="NGN">NGN</option>
                        <option value="KES">KES</option>
                        <option value="GHS">GHS</option>
                        <option value="USD">USD</option>
                      </select>
                    </div>
                  )}
                </div>

              {/* Submit */}
              <button
                type="button"
                onClick={() => setShowConfirm(true)}
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
          </>
        )}
        </div>

        {/* ── Payment confirmation modal ── */}
        {showConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-payment-title"
          >
            <div className="w-full max-w-sm rounded-xl border border-white/10 bg-solar-accent p-6 shadow-2xl">
              <h3 id="confirm-payment-title" className="text-lg font-semibold text-white mb-4">
                Confirm Payment
              </h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Meter ID</span>
                  <strong className="text-white">{meterId}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Plan</span>
                  <strong className="text-white capitalize">{plan}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Amount</span>
                  <div className="text-right">
                    <strong className="text-solar-yellow">{amount} XLM</strong>
                    {xlmRate && (
                      <div className="text-xs text-gray-400">
                        ≈ {(parseFloat(amount) * xlmRate).toLocaleString('en-NG', { 
                          style: 'currency', 
                          currency: currency 
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-lg border border-white/10 bg-transparent px-4 py-2.5 text-sm font-semibold text-gray-300 hover:bg-white/5 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmPayment}
                  disabled={status === "loading"}
                  className="flex-1 rounded-lg bg-solar-yellow px-4 py-2.5 text-sm font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  Confirm & Sign
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── SMS modal ── */}
      {showSmsModal && (
        <OfflinePaymentModal meterId={meterId} onClose={() => setShowSmsModal(false)} />
      )}
    </>
  );
}
