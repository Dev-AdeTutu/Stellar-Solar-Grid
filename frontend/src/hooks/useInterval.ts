"use client";

import { useEffect, useRef } from "react";

/**
 * useInterval
 *
 * Runs `callback` on a fixed `delay` (ms) interval.
 * - Passing `null` as delay suspends the interval without unmounting.
 * - Always uses the latest callback ref so stale closures are never an issue.
 * - Does NOT fire on the first render — the initial fetch is the caller's
 *   responsibility (avoids double-fetch when combined with useEffect).
 * - Cleans up the interval on unmount automatically.
 *
 * Based on the pattern by Dan Abramov (overreacted.io/making-setinterval-declarative-with-react-hooks)
 *
 * @example
 * useInterval(fetchBalance, 30_000);          // poll every 30s
 * useInterval(fetchBalance, null);            // paused
 * useInterval(fetchBalance, isOnline ? 30_000 : null); // conditional
 */
export function useInterval(callback: () => void, delay: number | null): void {
  const savedCallback = useRef<() => void>(callback);

  // Keep the ref pointing at the latest callback without restarting the interval
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    // null delay means "pause" — don't start an interval
    if (delay === null) return;

    const id = setInterval(() => {
      savedCallback.current();
    }, delay);

    return () => clearInterval(id);
  }, [delay]); // restart only when delay changes
}
