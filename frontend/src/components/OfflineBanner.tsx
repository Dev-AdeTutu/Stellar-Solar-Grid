"use client";

import { useEffect, useState } from "react";

const LAST_SYNC_KEY = "solargrid-last-sync";

/** Shows a persistent banner while offline, with the timestamp of the last time the app was online. */
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    setLastSync(localStorage.getItem(LAST_SYNC_KEY));

    const updateStatus = () => {
      const offline = !navigator.onLine;
      setIsOffline(offline);
      if (!offline) {
        const now = new Date().toISOString();
        localStorage.setItem(LAST_SYNC_KEY, now);
        setLastSync(now);
      }
    };

    updateStatus();
    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);
    return () => {
      window.removeEventListener("online", updateStatus);
      window.removeEventListener("offline", updateStatus);
    };
  }, []);

  if (!isOffline) return null;

  const syncLabel = lastSync
    ? new Date(lastSync).toLocaleString()
    : "unknown";

  return (
    <div
      role="status"
      className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 bg-yellow-900/90 text-yellow-200 text-xs sm:text-sm px-4 py-2 backdrop-blur-sm"
    >
      <span>📡</span>
      <span>
        Offline Mode — showing cached data. Last synced: {syncLabel}
      </span>
    </div>
  );
}
