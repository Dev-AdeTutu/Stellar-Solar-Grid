"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { isContractPaused } from "@/lib/contract";

const POLL_INTERVAL_MS = 30_000;

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

    void checkPauseState();
    const interval = window.setInterval(() => void checkPauseState(), POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
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
