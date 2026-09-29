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
    if (id) void configureWidget(id, env.NEXT_PUBLIC_BACKEND_URL);
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
