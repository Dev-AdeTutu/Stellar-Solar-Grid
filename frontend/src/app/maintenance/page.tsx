'use client';

import { useEffect, useState } from 'react';

interface MaintenanceWindow {
  id: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  affected_meters?: string[];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export default function MaintenancePage() {
  const [upcoming, setUpcoming] = useState<MaintenanceWindow[]>([]);
  const [active, setActive] = useState<MaintenanceWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [upcomingRes, activeRes] = await Promise.all([
          fetch('/api/maintenance/upcoming'),
          fetch('/api/maintenance/active'),
        ]);

        if (!upcomingRes.ok) {
          throw new Error(`Failed to load upcoming maintenance (${upcomingRes.status})`);
        }
        if (!activeRes.ok) {
          throw new Error(`Failed to load active maintenance (${activeRes.status})`);
        }

        const upcomingData = await upcomingRes.json();
        const activeData = await activeRes.json();

        if (cancelled) {
          return;
        }

        setUpcoming(Array.isArray(upcomingData) ? upcomingData : upcomingData.windows ?? []);
        setActive(Array.isArray(activeData) ? activeData : activeData.windows ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load maintenance windows');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  function renderWindow(window: MaintenanceWindow) {
    return (
      <li key={window.id} className="maintenance-window">
        <h3>{window.title}</h3>
        {window.description ? <p>{window.description}</p> : null}
        <p>
          <strong>Start:</strong> {formatDateTime(window.start_time)}
        </p>
        <p>
          <strong>End:</strong> {formatDateTime(window.end_time)}
        </p>
        <div>
          <strong>Affected meters:</strong>
          {window.affected_meters && window.affected_meters.length > 0 ? (
            <ul>
              {window.affected_meters.map((meter) => (
                <li key={meter}>{meter}</li>
              ))}
            </ul>
          ) : (
            <p>No affected meters listed.</p>
          )}
        </div>
      </li>
    );
  }

  return (
    <main className="maintenance-page">
      <h1>Scheduled Maintenance</h1>

      {loading ? <p>Loading maintenance windows…</p> : null}

      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      {!loading && !error ? (
        <>
          <section>
            <h2>Active Maintenance</h2>
            {active.length > 0 ? (
              <ul>{active.map(renderWindow)}</ul>
            ) : (
              <p>No active maintenance at this time.</p>
            )}
          </section>

          <section>
            <h2>Upcoming Maintenance</h2>
            {upcoming.length > 0 ? (
              <ul>{upcoming.map(renderWindow)}</ul>
            ) : (
              <p>No scheduled maintenance.</p>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}