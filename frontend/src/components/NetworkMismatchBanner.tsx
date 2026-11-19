"use client";

import { useEffect, useState } from "react";
import { useWalletStore } from "@/store/walletStore";

const DISMISSAL_KEY_PREFIX = "network-mismatch-dismissed:";

const dismissalKey = (message: string) => `${DISMISSAL_KEY_PREFIX}${message}`;

// Guard both SSR and environments where localStorage is blocked/unavailable.
const wasDismissed = (message?: string | null): boolean => {
  if (!message || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(dismissalKey(message)) === "true";
  } catch {
    return false;
  }
};

/**
 * NetworkMismatchBanner (#575)
 *
 * Displays a yellow warning banner below the nav bar when the connected wallet
 * is on a different Stellar network than the app expects.
 *
 * Design decisions:
 * - Reads `networkError` from walletStore — the store already performs the
 *   comparison in `checkNetworkMismatch()` on connect.
 * - Listens to wallet-change events from the StellarWalletsKit instance so the
 *   banner dismisses automatically when the user switches to the correct network
 *   without polling.
 * - Never renders when no wallet is connected (`address` is null).
 * - Uses `role="alert"` + `aria-live="polite"` for screen-reader accessibility.
 */
export function NetworkMismatchBanner() {
  const address = useWalletStore((s) => s.address);
  const kit = useWalletStore((s) => s.kit);
  const networkError = useWalletStore((s) => s.networkError);
  const [dismissed, setDismissed] = useState(() => wasDismissed(networkError));

  // Reset the in-memory flag whenever the mismatch message changes, while
  // still honouring a stored dismissal for that specific message. A different
  // mismatch has no stored flag, so it surfaces again after a re-connect.
  useEffect(() => {
    setDismissed(wasDismissed(networkError));
  }, [networkError]);

  const dismiss = () => {
    setDismissed(true);
    if (!networkError || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(dismissalKey(networkError), "true");
    } catch {
      // In-memory dismissal still applies when storage is unavailable.
    }
  };

  // Subscribe to wallet-kit network/account-change events so the banner
  // dismisses automatically when the user switches to the expected network.
  useEffect(() => {
    if (!kit) return;

    const handleWalletChange = async () => {
      // Let walletStore re-evaluate the network via the existing connect flow.
      // We only need to clear the local dismiss flag so the updated value shows.
      setDismissed(false);
    };

    // StellarWalletsKit emits these events on wallet / account changes
    try {
      (kit as any).on?.("walletChanged", handleWalletChange);
      (kit as any).on?.("accountChanged", handleWalletChange);
    } catch {
      // Kit may not support .on() — graceful fallback
    }

    return () => {
      try {
        (kit as any).off?.("walletChanged", handleWalletChange);
        (kit as any).off?.("accountChanged", handleWalletChange);
      } catch {
        // ignore
      }
    };
  }, [kit]);

  // Do not render: no wallet connected, no mismatch, or already dismissed
  if (!address || !networkError || dismissed) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="network-mismatch-banner"
      className="flex items-center justify-between gap-3 border-b border-yellow-500/30 bg-yellow-900/20 px-4 py-2.5 text-sm text-yellow-300"
    >
      <span className="flex items-center gap-2">
        <svg
          className="h-4 w-4 shrink-0 text-yellow-400"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <span>
          <strong className="font-semibold">Wrong network:</strong> {networkError}
        </span>
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss network mismatch warning"
        className="shrink-0 text-yellow-400 hover:text-white transition"
      >
        ✕
      </button>
    </div>
  );
}
