"use client";
import { useState } from "react";
import { disableAutoTopup, enableAutoTopup } from "@/services/autoTopupService";

/** Animated spinner used during the saving handshake */
function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12" cy="12" r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

export default function AutoTopupSettings({ sourceAddress, meterId }: { sourceAddress: string; meterId: string }) {
  const [threshold, setThreshold] = useState("10");
  const [amount, setAmount] = useState("25");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  async function save() {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const thresholdStroops = BigInt(Math.round(Number(threshold) * 10_000_000));
      const amountStroops = BigInt(Math.round(Number(amount) * 10_000_000));
      if (enabled) await enableAutoTopup(sourceAddress, meterId, thresholdStroops, amountStroops);
      else await disableAutoTopup(sourceAddress, meterId);
      setStatus(enabled ? "Auto top-up enabled" : "Auto top-up disabled");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not update auto top-up"); }
    finally { setIsSaving(false); }
  }
  return <section className="rounded-xl border border-white/10 bg-solar-accent p-4 space-y-3" aria-label="Auto top-up settings"><h2 className="font-semibold text-white">Auto top-up</h2><label className="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Automatically add funds when balance is low</label><div className="grid grid-cols-2 gap-3"><label className="text-xs text-gray-400">Threshold (XLM)<input type="number" min="0.000001" step="0.000001" value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!enabled} className="mt-1 w-full rounded bg-solar-dark p-2 text-white" /></label><label className="text-xs text-gray-400">Top-up amount (XLM)<input type="number" min="0.000001" step="0.000001" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!enabled} className="mt-1 w-full rounded bg-solar-dark p-2 text-white" /></label></div><p className="text-xs text-gray-500">Approve the contract to spend the top-up amount before enabling automation.</p>{status && <p role="status" className="text-xs text-green-400">{status}</p>}<button type="button" onClick={save} disabled={isSaving} className="rounded bg-solar-yellow px-4 py-2 text-sm font-semibold text-solar-dark disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5">{isSaving && <Spinner />}{isSaving ? "Saving…" : "Save settings"}</button></section>;
}