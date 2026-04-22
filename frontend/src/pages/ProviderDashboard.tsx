import { useState } from "react";
import styles from "./ProviderDashboard.module.css";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type Meter = {
  id: string;
  owner: string;
  active: boolean;
  balance: number;
  usage: number;
};

const initialMeters: Meter[] = [
  { id: "METER1", owner: "GABC…1234", active: true, balance: 4.5, usage: 12.3 },
  { id: "METER2", owner: "GDEF…5678", active: false, balance: 0, usage: 8.1 },
  { id: "METER3", owner: "GHIJ…9012", active: true, balance: 2.1, usage: 5.7 },
  { id: "METER4", owner: "GKLM…3456", active: true, balance: 7.0, usage: 20.0 },
];

const revenueData = [
  { month: "Jan", xlm: 120 },
  { month: "Feb", xlm: 180 },
  { month: "Mar", xlm: 150 },
  { month: "Apr", xlm: 210 },
  { month: "May", xlm: 260 },
  { month: "Jun", xlm: 300 },
];

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export default function ProviderDashboard() {
  const [meters, setMeters] = useState<Meter[]>(initialMeters);
  const [meterId, setMeterId] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const activeCount = meters.filter((m) => m.active).length;
  const totalRevenue = revenueData.reduce((s, r) => s + r.xlm, 0);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch(`${API}/api/meters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meter_id: meterId.trim(),
          owner: ownerAddress.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Registration failed");

      // Optimistically append the new meter to the table
      setMeters((prev) => [
        ...prev,
        {
          id: meterId.trim(),
          owner: ownerAddress.trim(),
          active: false,
          balance: 0,
          usage: 0,
        },
      ]);
      setMeterId("");
      setOwnerAddress("");
      setFeedback({ ok: true, msg: `Meter registered. Tx: ${data.hash}` });
    } catch (err: any) {
      setFeedback({ ok: false, msg: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Provider Dashboard</h1>

      <div className={styles.stats}>
        <div className="card">
          <p className={styles.label}>Total Meters</p>
          <p className={styles.value}>{meters.length}</p>
        </div>
        <div className="card">
          <p className={styles.label}>Active Meters</p>
          <p className={`${styles.value} badge-active`}>{activeCount}</p>
        </div>
        <div className="card">
          <p className={styles.label}>Total Revenue</p>
          <p className={styles.value}>{totalRevenue} XLM</p>
        </div>
      </div>

      {/* ── Register Meter Form ── */}
      <div className={`card ${styles.formCard}`}>
        <p className={styles.label}>Register New Meter</p>
        <form className={styles.form} onSubmit={handleRegister}>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label htmlFor="meterId">Meter ID</label>
              <input
                id="meterId"
                type="text"
                placeholder="e.g. METER5"
                value={meterId}
                onChange={(e) => setMeterId(e.target.value)}
                required
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="ownerAddress">Owner Address</label>
              <input
                id="ownerAddress"
                type="text"
                placeholder="G…"
                value={ownerAddress}
                onChange={(e) => setOwnerAddress(e.target.value)}
                required
                disabled={submitting}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? "Registering…" : "Register Meter"}
            </button>
          </div>
          {feedback && (
            <p className={feedback.ok ? styles.feedbackOk : styles.feedbackErr}>
              {feedback.msg}
            </p>
          )}
        </form>
      </div>

      <div className={`card ${styles.chart}`}>
        <p className={styles.label}>Monthly Revenue (XLM)</p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={revenueData}>
            <XAxis dataKey="month" stroke="#7a8fa6" />
            <YAxis stroke="#7a8fa6" />
            <Tooltip contentStyle={{ background: "#1c2b3a", border: "none" }} />
            <Bar dataKey="xlm" fill="#1a73e8" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className={`card ${styles.tableWrap}`}>
        <p className={styles.label}>Meter Registry</p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Meter ID</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Balance (XLM)</th>
              <th>Usage (kWh)</th>
            </tr>
          </thead>
          <tbody>
            {meters.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td className={styles.mono}>{m.owner}</td>
                <td>
                  <span
                    className={m.active ? "badge-active" : "badge-inactive"}
                  >
                    {m.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td>{m.balance}</td>
                <td>{m.usage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
