"use client";

/**
 * Keeps the native home-screen widget pointed at the meter the user is
 * working with, and routes widget taps (solargrid:// deep links) into the
 * app (#901). Renders nothing; does nothing on web.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePaymentStore } from "@/store/paymentStore";
import { configureWidget, isNativeApp, onAppUrlOpen, routeForWidgetUrl } from "@/lib/widgetBridge";
import { env } from "@/lib/env";

const LAST_METER_KEY = "widgetMeterId";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function delay(ms: number, signal: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Allow cancellation to short-circuit the wait.
    if (signal.cancelled) {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function WidgetSync() {
  const router = useRouter();
  const meterId = usePaymentStore((s) => s.meterId);

  useEffect(() => {
    if (!isNativeApp()) return;
    let id = meterId.trim();
    try {
      if (id) localStorage.setItem(LAST_METER_KEY, id);
      else id = localStorage.getItem(LAST_METER_KEY) ?? "";
    } catch {
      // storage unavailable
    }
    if (!id) return;

    const state = { cancelled: false };

    const syncWithRetry = async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (state.cancelled) return;
        try {
          await configureWidget(id, env.NEXT_PUBLIC_BACKEND_URL);
          // Success: clear any failed state.
          if (state.cancelled) return;
          try {
            localStorage.removeItem("widgetSyncFailed");
          } catch {
            // storage unavailable
          }
          return;
        } catch {
          if (state.cancelled) return;
          if (attempt < MAX_ATTEMPTS - 1) {
            await delay(BASE_DELAY_MS * 2 ** attempt, state);
          }
        }
      }
      // All attempts exhausted: mark sync as failed.
      if (state.cancelled) return;
      try {
        localStorage.setItem("widgetSyncFailed", "1");
      } catch {
        // storage unavailable
      }
    };

    void syncWithRetry();

    return () => {
      state.cancelled = true;
    };
  }, [meterId]);

  useEffect(
    () =>
      onAppUrlOpen((url) => {
        const route = routeForWidgetUrl(url);
        if (route) router.push(route);
      }),
    [router],
  );

  return null;
}