"use client";

import { useState } from "react";

const SMS_SHORTCODE = process.env.NEXT_PUBLIC_SMS_SHORTCODE ?? "20880";
const SMS_WEBHOOK_DOCS =
  process.env.NEXT_PUBLIC_SMS_WEBHOOK_DOCS ??
  "https://github.com/damiedee96/Stellar-Solar-Grid/blob/main/backend/README.md";

interface Props {
  meterId?: string;
  onClose: () => void;
}

const PLANS = [
  { code: "D", label: "Daily" },
  { code: "W", label: "Weekly" },
  { code: "U", label: "Usage-Based" },
];

export default function OfflinePaymentModal({ meterId, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const exampleMeter = meterId?.trim() || "METER1";
  const exampleSms = `PAY ${exampleMeter} 5 D`;

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable on some low-end browsers — silently ignore
    }
  }

  return (
    /* Backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-modal-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0"
    >
      {/* Dim overlay */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — slides up from bottom on mobile */}
      <div className="relative w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-solar-accent border border-white/10 shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-yellow-900/20">
          <div className="flex items-center gap-2">
            <span className="text-xl">📵</span>
            <h2 id="offline-modal-title" className="font-bold text-solar-yellow text-base">
              No Internet? Pay via SMS
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-gray-400 hover:text-white hover:bg-white/10 transition"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-5 space-y-5 max-h-[80vh] overflow-y-auto">

          {/* Offline banner */}
          <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-900/20 px-3 py-2.5 text-xs text-yellow-300">
            <span>⚠️</span>
            <span>You appear to be offline. Use SMS to top up your meter without internet.</span>
          </div>

          {/* Step 1 */}
          <section>
            <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-solar-yellow text-solar-dark text-xs font-bold">1</span>
              SMS Format
            </h3>
            <p className="text-xs text-gray-400 mb-2">
              Send an SMS to <span className="text-solar-yellow font-bold">{SMS_SHORTCODE}</span> using this format:
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-solar-dark px-4 py-3">
              <code className="flex-1 text-sm text-solar-yellow font-mono tracking-wide">
                PAY &lt;METER_ID&gt; &lt;AMOUNT&gt; &lt;PLAN&gt;
              </code>
            </div>
          </section>

          {/* Example */}
          <section>
            <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-solar-yellow text-solar-dark text-xs font-bold">2</span>
              Example
            </h3>
            <div className="flex items-center gap-2 rounded-lg border border-solar-yellow/30 bg-solar-yellow/5 px-4 py-3">
              <code className="flex-1 text-sm text-white font-mono">{exampleSms}</code>
              <button
                onClick={() => copyToClipboard(exampleSms)}
                aria-label="Copy SMS example"
                className="shrink-0 rounded-md border border-white/10 px-2.5 py-1 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Send to: <span className="text-solar-yellow font-bold">{SMS_SHORTCODE}</span>
            </p>
          </section>

          {/* Plan codes */}
          <section>
            <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-solar-yellow text-solar-dark text-xs font-bold">3</span>
              Plan Codes
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {PLANS.map((p) => (
                <div
                  key={p.code}
                  className="rounded-lg border border-white/10 bg-solar-dark px-3 py-2.5 text-center"
                >
                  <div className="text-solar-yellow font-bold font-mono text-base">{p.code}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{p.label}</div>
                </div>
              ))}
            </div>
          </section>

          {/* What happens next */}
          <section className="rounded-lg border border-white/10 bg-solar-dark px-4 py-3 text-xs text-gray-400 space-y-1">
            <p className="font-semibold text-gray-300 mb-1">What happens next?</p>
            <p>✓ You&apos;ll receive a confirmation SMS within 60 seconds.</p>
            <p>✓ Your meter will be topped up automatically.</p>
            <p>✓ Transaction is recorded on the Stellar blockchain.</p>
          </section>

          {/* Docs link */}
          <a
            href={SMS_WEBHOOK_DOCS}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 text-xs text-blue-400 underline underline-offset-2 hover:text-blue-300 transition py-1"
          >
            📄 View SMS webhook documentation ↗
          </a>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="w-full rounded-lg border border-white/10 py-3 text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
