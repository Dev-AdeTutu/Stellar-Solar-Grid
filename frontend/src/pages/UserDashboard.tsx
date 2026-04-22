import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useWalletStore } from "../store/walletStore";
import { fetchMeter, type MeterData } from "../lib/contract";
import styles from "./UserDashboard.module.css";

// Placeholder weekly usage — replace with real IoT data when available
const mockUsage = [
  { day: "Mon", kWh: 1.2 },
  { day: "Tue", kWh: 0.9 },
  { day: "Wed", kWh: 1.5 },
  { day: "Thu", kWh: 1.1 },
  { day: "Fri", kWh: 1.8 },
  { day: "Sat", kWh: 2.0 },
  { day: "Sun", kWh: 0.7 },
];

/** Derive a meter ID from a Stellar address (first 6 chars after G). */
function defaultMeterIdFor(address: string): string {
  return address.slice(0, 6).toUpperCase();
}

export default function UserDashboard() {
  const { address } = useWalletStore();

  const [meter, setMeter] = useState<MeterData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Manual meter ID lookup state
  const [lookupId, setLookupId] = useState("");
  const [lookupPending, setLookupPending] = useState(false);

  async function loadMeter(meterId: string) {
    setLoading(true);
    setError(null);
    setNotFound(false);
    setMeter(null);
    try {
      const data = await fetchMeter(meterId);
      setMeter(data);
    } catch (err: any) {
      if (err.message?.toLowerCase().includes("meter not found")) {
        setNotFound(true);
      } else {
        setError(err.message ?? "Failed to fetch meter data.");
      }
    } finally {
      setLoading(false);
    }
  }

  // Auto-fetch when wallet connects
  useEffect(() => {
    if (!address) {
      setMeter(null);
      setError(null);
      setNotFound(false);
      return;
    }
    loadMeter(defaultMeterIdFor(address));
  }, [address]);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupId.trim()) return;
    setLookupPending(true);
    await loadMeter(lookupId.trim().toUpperCase());
    setLookupPending(false);
  }

  if (!address) {
    return (
      <div className={styles.empty}>
        Connect your wallet to view your meter dashboard.
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>My Meter</h1>

      {loading && <p className={styles.status}>Loading meter data…</p>}

      {error && (
        <div className={styles.errorBox}>
          <p>{error}</p>
          <button
            className="btn-primary"
            onClick={() => loadMeter(defaultMeterIdFor(address))}
          >
            Retry
          </button>
        </div>
      )}

      {notFound && !loading && (
        <div className={styles.notFound}>
          <p>No meter registered for your address.</p>
          <p className={styles.sub}>
            If you have a meter ID, enter it below to look it up.
          </p>
          <form className={styles.lookupForm} onSubmit={handleLookup}>
            <input
              type="text"
              placeholder="Meter ID (e.g. METER1)"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              required
              disabled={lookupPending}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={lookupPending}
            >
              {lookupPending ? "Looking up…" : "Look Up"}
            </button>
          </form>
        </div>
      )}

      {meter && !loading && (
        <>
          <div className={styles.stats}>
            <div className="card">
              <p className={styles.label}>Status</p>
              <p className={meter.active ? "badge-active" : "badge-inactive"}>
                {meter.active ? "● Active" : "● Inactive"}
              </p>
            </div>
            <div className="card">
              <p className={styles.label}>Balance</p>
              <p className={styles.value}>{meter.balance.toFixed(2)} XLM</p>
            </div>
            <div className="card">
              <p className={styles.label}>Total Used</p>
              <p className={styles.value}>{meter.unitsUsed.toFixed(3)} kWh</p>
            </div>
            <div className="card">
              <p className={styles.label}>Plan</p>
              <p className={styles.value}>{meter.plan}</p>
            </div>
          </div>

          <div className={`card ${styles.chart}`}>
            <p className={styles.label}>Usage This Week</p>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={mockUsage}>
                <XAxis dataKey="day" stroke="#7a8fa6" />
                <YAxis stroke="#7a8fa6" unit=" kWh" />
                <Tooltip
                  contentStyle={{ background: "#1c2b3a", border: "none" }}
                />
                <Line
                  type="monotone"
                  dataKey="kWh"
                  stroke="#f5a623"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
