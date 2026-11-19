"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { isContractPaused } from "@/lib/contract";

const POLL_INTERVAL_MS = 30_000;

/**
 * Event name emitted whenever the contract pause state is observed to change
 * (e.g. via a WebSocket subscription or another component's poll). The detail
 * carries the latest paused value.
 */
export const CONTRACT_PAUSE_STATE_EVENT = "contract:pause-state";

export interface ContractPauseStateDetail {
  paused: boolean;
}

/**
 * Broadcasts the latest contract pause state to any listeners (such as the
 * pause banner) so the UI can react without waiting for the next poll.
 */
export function emitContractPauseState(paused: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ContractPauseStateDetail>(CONTRACT_PAUSE_STATE_EVENT, {
      detail: { paused },
    }),
  );
}

/**
 * Shows a global warning while the on-chain contract pause is active.
 *
 * The initial query and polling are deliberately best-effort: a temporary RPC
 * failure must not make the entire dashboard unusable or imply that payments
 * are available. The contract remains the source of truth for enforcement.
 */
export function ContractPauseBanner() {
  const t = useTranslations("pauseBanner");
  const [paused, setPaused] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let mounted = true;

    const checkPauseState = async () => {
      try {
        const nextPaused = await isContractPaused();
        if (mounted) setPaused(nextPaused);
      } catch {
        // RPC failures are transient; keep the last known state and retry.
      } finally {
        if (mounted) setChecked(true);
      }
    };

    const handlePauseStateEvent = (event: Event) => {
      const detail = (event as CustomEvent<ContractPauseStateDetail>).detail;
      if (!mounted || !detail || typeof detail.paused !== "boolean") return;
      setPaused(detail.paused);
      setChecked(true);
    };

    void checkPauseState();
    const interval = window.setInterval(() => void checkPauseState(), POLL_INTERVAL_MS);
    window.addEventListener(CONTRACT_PAUSE_STATE_EVENT, handlePauseStateEvent);

    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener(CONTRACT_PAUSE_STATE_EVENT, handlePauseStateEvent);
    };
  }, []);

  if (!checked || !paused) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="contract-pause-banner"
      className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-950/70 px-4 py-3 text-sm text-amber-200"
    >
      <span aria-hidden="true" className="text-lg">
        !
      </span>
      <span>
        <strong className="font-semibold">{t("title")}</strong>{" "}
        {t("message")}
      </span>
    </div>
  );
}
