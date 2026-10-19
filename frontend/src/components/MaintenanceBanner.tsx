'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { env } from '@/config/env';

interface MaintenanceWindow {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  affectedMeters?: string[];
}

interface MaintenanceBannerProps {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const UPCOMING_WINDOW_MS = 48 * 60 * 60 * 1000;

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes <= 0) {
    return 'now';
  }
  if (diffMinutes < 60) {
    return `in ${diffMinutes} minute${diffMinutes === 1 ? '' : 's'}`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 48) {
    return `in ${diffHours} hour${diffHours === 1 ? '' : 's'}`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `in ${diffDays} day${diffDays === 1 ? '' : 's'}`;
}

export default function MaintenanceBanner({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: MaintenanceBannerProps) {
  const [activeWindow, setActiveWindow] = useState<MaintenanceWindow | null>(null);
  const [upcomingWindow, setUpcomingWindow] = useState<MaintenanceWindow | null>(null);
  const [dismissedActiveId, setDismissedActiveId] = useState<string | null>(null);
  const [dismissedUpcomingId, setDismissedUpcomingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMaintenance = useCallback(async () => {
    try {
      const [activeRes, upcomingRes] = await Promise.all([
        fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/maintenance/active`, {
          headers: { Accept: 'application/json' },
        }),
        fetch(`${env.NEXT_PUBLIC_BACKEND_URL}/api/maintenance/upcoming`, {
          headers: { Accept: 'application/json' },
        }),
      ]);

      if (activeRes.ok) {
        const activeData = await activeRes.json();
        const window: MaintenanceWindow | null = Array.isArray(activeData)
          ? activeData[0] ?? null
          : activeData?.window ?? activeData ?? null;
        setActiveWindow(window);
      } else {
        setActiveWindow(null);
      }

      if (upcomingRes.ok) {
        const upcomingData = await upcomingRes.json();
        const windows: MaintenanceWindow[] = Array.isArray(upcomingData)
          ? upcomingData
          : upcomingData?.windows ?? [];
        const now = Date.now();
        const next = windows
          .filter((w) => {
            const start = new Date(w.startTime).getTime();
            return !Number.isNaN(start) && start > now && start - now <= UPCOMING_WINDOW_MS;
          })
          .sort(
            (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
          )[0] ?? null;
        setUpcomingWindow(next);
      } else {
        setUpcomingWindow(null);
      }
    } catch {
      // Silently ignore network errors; the banner simply won't render.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (!cancelled) {
        await fetchMaintenance();
      }
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchMaintenance, pollIntervalMs]);

  if (loading) {
    return null;
  }

  if (activeWindow && activeWindow.id !== dismissedActiveId) {
    return (
      <div
        role="alert"
        className="w-full border-b border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
      >
        <div className="mx-auto flex max-w-7xl items-start gap-3">
          <span aria-hidden="true" className="mt-0.5 text-lg">
            ⚠️
          </span>
          <div className="flex-1">
            <p className="text-sm font-semibold">
              Scheduled maintenance in progress: {activeWindow.title}
            </p>
            {activeWindow.description && (
              <p className="mt-1 text-sm text-amber-800">{activeWindow.description}</p>
            )}
            <p className="mt-1 text-xs text-amber-700">
              Expected to end {formatDateTime(activeWindow.endTime)}.
            </p>
            <Link
              href="/maintenance"
              className="mt-1 inline-block text-xs font-medium text-amber-900 underline hover:text-amber-700"
            >
              View affected meters
            </Link>
          </div>
          <button
            type="button"
            onClick={() => setDismissedActiveId(activeWindow.id)}
            aria-label="Dismiss maintenance banner"
            className="rounded p-1 text-amber-700 transition hover:bg-amber-100 hover:text-amber-900"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (upcomingWindow && upcomingWindow.id !== dismissedUpcomingId) {
    return (
      <div
        role="status"
        className="w-full border-b border-blue-200 bg-blue-50 px-4 py-2 text-blue-900"
      >
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <span aria-hidden="true" className="text-base">
            🗓️
          </span>
          <div className="flex-1">
            <p className="text-xs font-medium">
              Upcoming maintenance: {upcomingWindow.title} — starts{' '}
              {formatDateTime(upcomingWindow.startTime)} ({formatRelative(upcomingWindow.startTime)}).
            </p>
            <Link
              href="/maintenance"
              className="text-xs font-medium text-blue-900 underline hover:text-blue-700"
            >
              View details and affected meters
            </Link>
          </div>
          <button
            type="button"
            onClick={() => setDismissedUpcomingId(upcomingWindow.id)}
            aria-label="Dismiss upcoming maintenance banner"
            className="rounded p-1 text-blue-700 transition hover:bg-blue-100 hover:text-blue-900"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return null;
}