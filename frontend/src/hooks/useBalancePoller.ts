"use client";

import { useEffect, useRef } from "react";
import { useWalletStore } from "@/store/walletStore";

/**
 * useBalancePoller
 *
 * Polls a meter's balance and fires a browser Push Notification when the
 * balance drops below 20 % of the last recorded top-up.
 *
 * Rules:
 * - Calls `Notification.requestPermission()` once (guarded by localStorage).
 * - Threshold: currentBalance < lastTopUp * 0.20
 * - Rate-limit: at most one notification per meter per 4-hour window.
 *   The timestamp is persisted in localStorage so it survives page refreshes.
 * - Fully SSR-safe: every `window` / `Notification` access is wrapped in a
 *   `typeof window !== 'undefined'` guard.
 *
 * @param meterId  - The meter identifier to watch.
 * @param balance  - Current balance in stroops (bigint).
 * @param pollIntervalMs - How often to re-evaluate (default 30 s). Pass the
 *   same interval you use for the balance fetch so they stay in sync.
 */
export function useBalancePoller(
  meterId: string,
  balance: bigint | null,
  pollIntervalMs = 30_000,
): void {
  const lastTopUpPerMeter = useWalletStore((s) => s.lastTopUpPerMeter);

  // Keep a stable ref so the interval closure always sees the latest values
  // without restarting the timer.
  const stateRef = useRef({ meterId, balance, lastTopUpPerMeter });
  useEffect(() => {
    stateRef.current = { meterId, balance, lastTopUpPerMeter };
  });

  // Request notification permission once, store result so we don't spam
  // the browser dialog on every mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;

    const key = "sg_notification_permission_requested";
    if (!localStorage.getItem(key)) {
      Notification.requestPermission().then(() => {
        localStorage.setItem(key, "1");
      });
    }
  }, []);

  // Main evaluation loop — runs every `pollIntervalMs`.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const evaluate = () => {
      const { meterId: id, balance: bal, lastTopUpPerMeter: topUpMap } = stateRef.current;

      if (bal === null || bal === undefined) return;
      if (!("Notification" in window)) return;
      if (Notification.permission !== "granted") return;

      const lastTopUp = topUpMap[id];
      if (!lastTopUp || lastTopUp === 0n) return;

      // Threshold: balance < 20 % of last top-up
      const threshold = (lastTopUp * 20n) / 100n;
      if (bal >= threshold) return;

      // Rate-limit: suppress if we already notified within 4 hours
      const rateLimitKey = `sg_notif_ts_${id}`;
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      const lastNotifiedStr = localStorage.getItem(rateLimitKey);
      if (lastNotifiedStr) {
        const lastNotified = parseInt(lastNotifiedStr, 10);
        if (!isNaN(lastNotified) && Date.now() - lastNotified < FOUR_HOURS_MS) return;
      }

      // Fire notification
      try {
        const balanceXlm = (Number(bal) / 1e7).toFixed(2);
        new Notification("⚡ SolarGrid: Low Balance Warning", {
          body: `Meter ${id} balance is ${balanceXlm} XLM — less than 20% of your last top-up. Please recharge soon.`,
          icon: "/favicon.ico",
          tag: `sg-balance-${id}`,
        });
        localStorage.setItem(rateLimitKey, String(Date.now()));
      } catch {
        // Silently ignore notification errors (e.g., permission revoked mid-session)
      }
    };

    // Evaluate immediately on mount/update, then on each interval tick.
    evaluate();
    const id = setInterval(evaluate, pollIntervalMs);
    return () => clearInterval(id);
  }, [meterId, pollIntervalMs]);
}
