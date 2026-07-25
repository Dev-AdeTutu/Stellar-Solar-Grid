"use client";

import { useState } from "react";
import { useWalletStore } from "@/store/walletStore";

// ── Sub-components ─────────────────────────────────────────────────────────

/** Tooltip shown when Freighter is not detected */
function FreighterTooltip({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      role="tooltip"
      className="absolute bottom-full left-1/2 mb-2 w-56 -translate-x-1/2 rounded-lg border border-yellow-500/30 bg-yellow-900/90 px-3 py-2 text-xs text-yellow-200 shadow-xl backdrop-blur-sm z-50"
    >
      <p className="font-semibold mb-1">Freighter not detected</p>
      <a
        href="https://freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-white transition"
        onClick={(e) => e.stopPropagation()}
      >
        Install Freighter ↗
      </a>
      {/* Arrow */}
      <div
        aria-hidden="true"
        className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-yellow-900/90"
      />
    </div>
  );
}

/** Banner shown when Freighter is connected but pointed at the wrong network */
function WrongNetworkBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="absolute top-full left-1/2 mt-2 w-64 -translate-x-1/2 rounded-lg border border-orange-500/30 bg-orange-900/90 px-3 py-2 text-xs text-orange-200 shadow-xl backdrop-blur-sm z-50"
    >
      <p className="font-semibold mb-1">Wrong network</p>
      <p>{message} Switch networks in Freighter: Settings → Network.</p>
    </div>
  );
}

/** Animated spinner used during the connecting handshake */
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

// ── Props ──────────────────────────────────────────────────────────────────

interface WalletConnectButtonProps {
  /** Renders a smaller pill-shaped variant for mobile/compact layouts */
  compact?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

/**
 * WalletConnectButton
 *
 * Centralised connect/disconnect control for the Freighter wallet.
 * - Shows truncated address + copy + disconnect when connected
 * - Shows "Connect Wallet" with spinner while handshake is in progress
 * - Shows a tooltip with install link when Freighter is not detected
 * - Surfaces connectError from the wallet store inline
 *
 * Closes #398
 */
export function WalletConnectButton({ compact = false }: WalletConnectButtonProps) {
  const { address, connect, disconnect, isConnecting, connectError, clearConnectError, networkError } =
    useWalletStore();

  const [copied, setCopied] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const isNotInstalled =
    !!connectError &&
    (connectError.toLowerCase().includes("not installed") ||
      connectError.toLowerCase().includes("undefined"));

  const truncated = address
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : null;

  async function handleCopy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — silent fail
    }
  }

  function handleConnectClick() {
    if (isConnecting) return;
    clearConnectError();
    connect().then(() => {
      setTooltipVisible(false);
    });
  }

  // ── Connected state ──────────────────────────────────────────────────────
  if (address) {
    return (
      <div className="relative flex items-center gap-1.5">
        {/* Address pill — click to copy */}
        <button
          type="button"
          onClick={handleCopy}
          title="Click to copy full address"
          aria-label={`Wallet address ${address}. Click to copy.`}
          aria-describedby={networkError ? "wrong-network-banner" : undefined}
          className={[
            "rounded-lg border font-mono font-medium",
            networkError
              ? "border-orange-500/60 text-orange-300 hover:bg-orange-500/10"
              : "border-solar-yellow text-solar-yellow hover:bg-solar-yellow hover:text-solar-dark",
            "transition",
            compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-xs",
          ].join(" ")}
        >
          {copied ? "✓ Copied" : truncated}
        </button>

        {/* Wrong-network indicator */}
        {networkError && (
          <span
            aria-hidden="true"
            title="Wrong network"
            className="h-2 w-2 rounded-full bg-orange-400"
          />
        )}

        {/* Disconnect button */}
        <button
          type="button"
          onClick={disconnect}
          title="Disconnect wallet"
          aria-label="Disconnect wallet"
          className={[
            "rounded-lg border border-white/10 text-gray-400",
            "hover:border-red-500/50 hover:text-red-400 transition",
            compact ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-xs",
          ].join(" ")}
        >
          {compact ? "✕" : "Disconnect"}
        </button>

        {/* Wrong-network banner — distinct from the "not installed" tooltip */}
        {networkError && (
          <div id="wrong-network-banner">
            <WrongNetworkBanner message={networkError} />
          </div>
        )}
      </div>
    );
  }

  // ── Disconnected / connecting state ──────────────────────────────────────
  return (
    <div className="relative flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={handleConnectClick}
        disabled={isConnecting}
        onMouseEnter={() => isNotInstalled && setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        onFocus={() => isNotInstalled && setTooltipVisible(true)}
        onBlur={() => setTooltipVisible(false)}
        aria-busy={isConnecting}
        aria-describedby={isNotInstalled ? "freighter-tooltip" : undefined}
        className={[
          "rounded-lg bg-solar-yellow font-semibold text-solar-dark",
          "hover:brightness-110 transition",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          "flex items-center gap-1.5",
          compact ? "px-3 py-1.5 text-xs" : "px-4 py-1.5 text-sm",
        ].join(" ")}
      >
        {isConnecting && <Spinner />}
        {isConnecting ? "Connecting…" : compact ? "Connect" : "Connect Wallet"}
      </button>

      {/* Freighter not-installed tooltip */}
      <FreighterTooltip visible={tooltipVisible} />

      {/* Inline error (non-tooltip fallback for touch devices) */}
      {connectError && !isNotInstalled && (
        <p className="absolute top-full mt-1 w-max max-w-xs text-xs text-red-400 text-center">
          {connectError}
        </p>
      )}
    </div>
  );
}

export default WalletConnectButton;
