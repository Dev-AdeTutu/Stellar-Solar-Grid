import React, { useEffect, useState, useCallback } from 'react';

export interface BatteryStats {
  meterId: string;
  voltage: number;
  current: number;
  stateOfCharge: number;
  capacity: number;
  health: number;
  cycles: number;
  predictedReplacementDate: string | null;
  lastUpdated?: string;
}

interface BatteryDashboardProps {
  meterId: string;
  apiBaseUrl?: string;
  refreshIntervalMs?: number;
}

const HEALTH_WARNING_THRESHOLD = 80;

const formatDate = (value: string | null | undefined): string => {
  if (!value) {
    return 'Unknown';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const clampPercent = (value: number | null | undefined): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
};

const BatteryDashboard: React.FC<BatteryDashboardProps> = ({
  meterId,
  apiBaseUrl = '',
  refreshIntervalMs = 60000,
}) => {
  const [stats, setStats] = useState<BatteryStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBatteryStats = useCallback(async () => {
    if (!meterId) {
      setStats(null);
      setLoading(false);
      setError(null);
      return;
    }

    try {
      setError(null);
      const response = await fetch(
        `${apiBaseUrl}/api/meters/${encodeURIComponent(meterId)}/battery`
      );

      if (response.status === 404) {
        setStats(null);
        setLoading(false);
        return;
      }

      if (!response.ok) {
        throw new Error(`Failed to load battery stats (${response.status})`);
      }

      const data = (await response.json()) as BatteryStats;
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load battery stats');
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, meterId]);

  useEffect(() => {
    setLoading(true);
    fetchBatteryStats();
  }, [fetchBatteryStats]);

  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) {
      return undefined;
    }
    const interval = setInterval(fetchBatteryStats, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [fetchBatteryStats, refreshIntervalMs]);

  if (loading) {
    return (
      <div className="battery-dashboard battery-dashboard--loading" role="status">
        <p>Loading battery data…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="battery-dashboard battery-dashboard--error" role="alert">
        <p>Unable to load battery data: {error}</p>
        <button type="button" onClick={fetchBatteryStats}>
          Retry
        </button>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="battery-dashboard battery-dashboard--empty">
        <h2>Battery</h2>
        <p>No battery data available for this meter.</p>
      </div>
    );
  }

  const soc = clampPercent(stats.stateOfCharge);
  const health = clampPercent(stats.health);
  const healthWarning = health < HEALTH_WARNING_THRESHOLD;

  return (
    <div className="battery-dashboard">
      <h2>Battery</h2>

      <div className="battery-dashboard__section">
        <div className="battery-dashboard__label">
          <span>State of Charge</span>
          <span>{soc.toFixed(1)}%</span>
        </div>
        <div
          className="battery-dashboard__progress"
          role="progressbar"
          aria-valuenow={soc}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="State of charge"
        >
          <div
            className="battery-dashboard__progress-fill"
            style={{ width: `${soc}%` }}
          />
        </div>
      </div>

      <div className="battery-dashboard__section">
        <div className="battery-dashboard__label">
          <span>Battery Health</span>
          <span>{health.toFixed(1)}%</span>
        </div>
        <div
          className={`battery-dashboard__progress${
            healthWarning ? ' battery-dashboard__progress--warning' : ''
          }`}
          role="progressbar"
          aria-valuenow={health}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Battery health"
        >
          <div
            className="battery-dashboard__progress-fill"
            style={{ width: `${health}%` }}
          />
        </div>
        {healthWarning && (
          <p className="battery-dashboard__warning" role="alert">
            Warning: battery health is below {HEALTH_WARNING_THRESHOLD}%. Consider
            scheduling a replacement.
          </p>
        )}
      </div>

      <dl className="battery-dashboard__details">
        <div className="battery-dashboard__detail">
          <dt>Voltage</dt>
          <dd>{typeof stats.voltage === 'number' ? `${stats.voltage.toFixed(2)} V` : '—'}</dd>
        </div>
        <div className="battery-dashboard__detail">
          <dt>Current</dt>
          <dd>{typeof stats.current === 'number' ? `${stats.current.toFixed(2)} A` : '—'}</dd>
        </div>
        <div className="battery-dashboard__detail">
          <dt>Capacity</dt>
          <dd>{typeof stats.capacity === 'number' ? `${stats.capacity.toFixed(2)} Ah` : '—'}</dd>
        </div>
        <div className="battery-dashboard__detail">
          <dt>Cycle Count</dt>
          <dd>{typeof stats.cycles === 'number' ? stats.cycles : '—'}</dd>
        </div>
        <div className="battery-dashboard__detail">
          <dt>Predicted Replacement</dt>
          <dd>{formatDate(stats.predictedReplacementDate)}</dd>
        </div>
        {stats.lastUpdated && (
          <div className="battery-dashboard__detail">
            <dt>Last Updated</dt>
            <dd>{formatDate(stats.lastUpdated)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
};

export default BatteryDashboard;