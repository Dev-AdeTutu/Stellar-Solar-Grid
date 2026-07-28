"use client";

import { useState, useEffect } from "react";
import { useOffline } from "@/hooks/useOffline";
import { env } from "@/lib/env";

const SMS_SHORTCODE = env.NEXT_PUBLIC_SMS_SHORTCODE;
const SMS_WEBHOOK_DOCS = env.NEXT_PUBLIC_SMS_WEBHOOK_DOCS;
const BACKEND_URL = env.NEXT_PUBLIC_BACKEND_URL;
const SMS_CONFIG_CACHE_KEY = "sms-provider-config";

interface SmsProviderConfig {
  shortcode: string;
  provider: string;
  instructions?: string;
}

interface Props {
  meterId?: string;
  region?: string;
  onClose: () => void;
}

const PLANS = [
  { code: "D", label: "Daily" },
  { code: "W", label: "Weekly" },
  { code: "U", label: "Usage-Based" },
];

export default function OfflinePaymentModal({ meterId, region, onClose }: Props) {
  const isOffline = useOffline();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [smsConfig, setSmsConfig] = useState<SmsProviderConfig | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const cached = window.localStorage.getItem(SMS_CONFIG_CACHE_KEY);
      return cached ? (JSON.parse(cached) as SmsProviderConfig) : null;
    } catch {
      return null;
    }
  });
  const exampleMeter = meterId?.trim() || "METER1";
  const exampleSms = `PAY ${exampleMeter} 5 D`;
  const smsShortcode = smsConfig?.shortcode ?? FALLBACK_SHORTCODE;

  // Fetch the per-region/per-provider shortcode from the backend so
  // different deployments/telecom partners can show the correct code
  // without a rebuild. Cached locally so it still renders while offline.
  useEffect(() => {
    if (isOffline) return;
    const params = region ? `?region=${encodeURIComponent(region)}` : "";
    fetch(`${BACKEND_URL}/api/sms-config${params}`)
      .then((res) => (res.ok ? (res.json() as Promise<SmsProviderConfig>) : null))
      .then((data) => {
        if (!data) return;
        setSmsConfig(data);
        try {
          window.localStorage.setItem(SMS_CONFIG_CACHE_KEY, JSON.stringify(data));
        } catch {
          // localStorage may be unavailable (private browsing) — safe to skip caching.
        }
      })
      .catch(() => {
        // Network failure — keep whatever cached/fallback shortcode is already shown.
      });
  }, [isOffline, region]);

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    } catch {}
    // Fallback for HTTP / low-end browsers
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopyFailed(true);
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
          {isOffline && (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-900/20 px-3 py-2.5 text-xs text-yellow-300" role="alert">
              <span>⚠️</span>
              <span>You are offline. Use the QR code below for offline payment.</span>
            </div>
          )}

          {/* QR code section — highlighted as primary CTA when offline */}
          <section
            className={`rounded-lg border px-4 py-4 text-center transition ${
              isOffline
                ? "border-solar-yellow bg-solar-yellow/10 ring-2 ring-solar-yellow/40"
                : "border-white/10 bg-solar-dark"
            }`}
            aria-label="QR code for offline payment"
          >
            <p className="text-xs font-semibold text-solar-yellow mb-3">
              {isOffline ? "📲 Scan QR to pay offline" : "Offline payment QR code"}
            </p>
            <div className="inline-flex items-center justify-center rounded-lg bg-white p-3">
              {/* QR placeholder — replace with <QRCode value={...} /> if a library is available */}
              <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true">
                <rect width="80" height="80" fill="white" />
                <rect x="5" y="5" width="30" height="30" fill="none" stroke="black" strokeWidth="5" />
                <rect x="12" y="12" width="16" height="16" fill="black" />
                <rect x="45" y="5" width="30" height="30" fill="none" stroke="black" strokeWidth="5" />
                <rect x="52" y="12" width="16" height="16" fill="black" />
                <rect x="5" y="45" width="30" height="30" fill="none" stroke="black" strokeWidth="5" />
                <rect x="12" y="52" width="16" height="16" fill="black" />
                <rect x="45" y="45" width="10" height="10" fill="black" />
                <rect x="60" y="45" width="10" height="10" fill="black" />
                <rect x="45" y="60" width="10" height="10" fill="black" />
                <rect x="60" y="60" width="10" height="10" fill="black" />
              </svg>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              Scan with your phone to initiate an offline SMS payment
            </p>
          </section>

          {/* Step 1 */}
          <section>
            <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-solar-yellow text-solar-dark text-xs font-bold">1</span>
              SMS Format
            </h3>
            <p className="text-xs text-gray-400 mb-2">
              Send an SMS to <span className="text-solar-yellow font-bold">{smsShortcode}</span> using this format:
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-solar-dark px-4 py-3">
              <code className="flex-1 text-sm text-solar-yellow font-mono tracking-wide">
                PAY &lt;METER_ID&gt; &lt;AMOUNT&gt; &lt;PLAN&gt;
              </code>
            </div>
            {smsConfig?.instructions && (
              <p className="mt-2 text-xs text-gray-400">{smsConfig.instructions}</p>
            )}
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
            {copyFailed && (
              <div className="mt-2">
                <p className="text-xs text-yellow-400 mb-1">Could not copy automatically. Select and copy the text below:</p>
                <textarea
                  readOnly
                  value={exampleSms}
                  className="w-full rounded-md border border-yellow-500/40 bg-solar-dark px-3 py-2 text-sm text-solar-yellow font-mono resize-none"
                  rows={2}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="SMS text to copy manually"
                />
              </div>
            )}
            <p className="mt-1.5 text-xs text-gray-500">
              Send to: <span className="text-solar-yellow font-bold">{smsShortcode}</span>
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
        <div className="px-5 py-4 border-t border-white/10 space-y-2">
          <button
            type="submit"
            disabled={isOffline}
            aria-disabled={isOffline}
            title={isOffline ? "Blockchain payments unavailable while offline. Use QR or SMS above." : undefined}
            className={`w-full rounded-lg py-3 text-sm font-semibold transition ${
              isOffline
                ? "bg-solar-yellow/30 text-solar-dark/50 cursor-not-allowed"
                : "bg-solar-yellow text-solar-dark hover:opacity-90"
            }`}
          >
            {isOffline ? "Offline — use QR" : "Pay"}
          </button>
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
