"use client";

import { useEffect, useState } from "react";

/**
 * Returns true when the browser reports no network connectivity.
 * Listens to the window online/offline events so the value stays
 * in sync without polling.
 */
export function useOffline(): boolean {
  // navigator.onLine can be undefined in SSR — default to false (online)
  const [isOffline, setIsOffline] = useState<boolean>(false);

  useEffect(() => {
    // Set initial state from browser API
    setIsOffline(!navigator.onLine);

    function goOffline() { setIsOffline(true); }
    function goOnline()  { setIsOffline(false); }

    window.addEventListener("offline", goOffline);
    window.addEventListener("online",  goOnline);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online",  goOnline);
    };
  }, []);

  return isOffline;
}
