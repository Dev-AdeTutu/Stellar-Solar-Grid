"use client";

import { useEffect } from "react";
import { flushQueuedActions } from "@/lib/offlineQueue";

/** Registers the offline-caching service worker and flushes any queued offline actions on reconnect. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed", err);
    });

    const onOnline = () => {
      flushQueuedActions().catch((err) => console.error("Failed to flush offline queue", err));
    };
    window.addEventListener("online", onOnline);
    // Also try once on mount in case we loaded already-online with a stale queue.
    onOnline();

    return () => window.removeEventListener("online", onOnline);
  }, []);

  return null;
}
