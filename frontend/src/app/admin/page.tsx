"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const STROOPS_PER_XLM = 10_000_000;

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem("admin_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Daily cap form (existing) ────────────────────────────────────────────────

function DailyCapForm() {
  const [meterId, setMeterId] = useState("");
  const [limitXlm, setLimitXlm] = useState("");
  const [autoDeactivate, setAutoDeactivate] = useState(true);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const trimmedId = meterId.trim();
    const limitNum = Number(limitXlm);
    if (!trimmedId) {
      setStatus({ kind: "error", text: "Meter ID is required" });
      return;
    }
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      setStatus({ kind: "error", text: "Daily cap must be a non-negative number of XLM" });
      return;
    }
    setSubmitting(true);
    try {
      const limitStroops = Math.round(limitNum * STROOPS_PER_XLM);
      const limitRes = await fetch(`${API}/api/meters/${encodeURIComponent(trimmedId)}/set-daily-limit`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ limit: limitStroops }),
      });
      const limitData = await limitRes.json();
      if (!limitRes.ok) {
        setStatus({ kind: "error", text: limitData.error ?? "Failed to set daily limit" });
        return;
      }
      const modeRes = await fetch(`${API}/api/meters/${encodeURIComponent(trimmedId)}/set-cap-mode`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ autoDeactivate }),
      });
      const modeData = await modeRes.json();
      if (!modeRes.ok) {
        setStatus({ kind: "error", text: modeData.error ?? "Failed to set cap mode" });
        return;
      }
      setStatus({
        kind: "ok",
        text:
          limitNum === 0
            ? `Daily cap removed for ${trimmedId}`
            : `Daily cap set to ${limitNum} XLM/day for ${trimmedId} (${autoDeactivate ? "auto-deactivate" : "warn only"})`,
      });
    } catch {
      setStatus({ kind: "error", text: "Network error — could not reach server" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-white/10 bg-solar-accent p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">Daily Usage Cap</h2>
      <p className="text-xs text-gray-400">
        Limit how much a meter can spend per day. Alerts fire at 80% and 100% of the cap.
      </p>
      <div>
        <label htmlFor="cap-meter-id" className="block text-sm font-medium text-gray-300 mb-1.5">Meter ID</label>
        <input
          id="cap-meter-id"
          type="text"
          value={meterId}
          onChange={(e) => setMeterId(e.target.value)}
          required
          disabled={submitting}
          className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
        />
      </div>
      <div>
        <label htmlFor="cap-limit" className="block text-sm font-medium text-gray-300 mb-1.5">Daily cap (XLM/day, 0 = unlimited)</label>
        <input
          id="cap-limit"
          type="number"
          min={0}
          step="any"
          value={limitXlm}
          onChange={(e) => setLimitXlm(e.target.value)}
          required
          disabled={submitting}
          className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
        />
      </div>
      <fieldset disabled={submitting}>
        <legend className="block text-sm font-medium text-gray-300 mb-1.5">When the cap is reached</legend>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="radio" name="cap-mode" checked={autoDeactivate} onChange={() => setAutoDeactivate(true)} className="accent-solar-yellow" />
            Auto-deactivate — block further usage (default)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="radio" name="cap-mode" checked={!autoDeactivate} onChange={() => setAutoDeactivate(false)} className="accent-solar-yellow" />
            Warn only — keep the meter running
          </label>
        </div>
      </fieldset>
      {status && <p className={`text-xs ${status.kind === "ok" ? "text-green-400" : "text-red-400"}`}>{status.text}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-solar-yellow py-3 text-sm font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {submitting ? "Saving…" : "Save daily cap"}
      </button>
    </form>
  );
}

// ── System health panel ──────────────────────────────────────────────────────

type SystemHealth = {
  uptime: number;
  nodeVersion: string;
  cpu: { model: string; cores: number; loadAvg1m: number };
  memory: { totalMb: number; freeMb: number; usedPercent: number };
  process: { heapUsedMb: number; heapTotalMb: number; rssMb: number };
  timestamp: string;
};

function SystemHealthPanel() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/dashboard/system-health`, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      setHealth(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <p className="text-red-400 text-sm">Failed to load system health.</p>;
  if (!health) return <p className="text-sm opacity-60">Loading…</p>;

  const uptimeH = Math.floor(health.uptime / 3600);
  const uptimeM = Math.floor((health.uptime % 3600) / 60);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-3">
      <h2 className="text-lg font-semibold">System Health</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Uptime</div>
          <div className="font-semibold">{uptimeH}h {uptimeM}m</div>
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">CPU load (1m)</div>
          <div className="font-semibold">{health.cpu.loadAvg1m} ({health.cpu.cores} cores)</div>
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Memory used</div>
          <div className="font-semibold">{health.memory.usedPercent}%</div>
          <div className="text-xs opacity-50">{health.memory.freeMb} MB free</div>
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Heap (MB)</div>
          <div className="font-semibold">{health.process.heapUsedMb} / {health.process.heapTotalMb}</div>
        </div>
      </div>
      <p className="text-xs opacity-40">Node {health.nodeVersion} · Updated {new Date(health.timestamp).toLocaleTimeString()}</p>
    </div>
  );
}

// ── Analytics panel ──────────────────────────────────────────────────────────

type AnalyticsSummary = {
  users: { total: number; active: number; suspended: number };
  transactions: { total: number; last24h: number; totalVolumeXlm: number; last24hVolumeXlm: number };
  roles: { role: string; count: number }[];
  generatedAt: string;
};

function AnalyticsPanel() {
  const [data, setData] = useState<AnalyticsSummary | null>(null);

  useEffect(() => {
    fetch(`${API}/api/admin/dashboard/analytics`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
  }, []);

  if (!data) return <p className="text-sm opacity-60">Loading analytics…</p>;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h2 className="text-lg font-semibold mb-3">Platform Analytics</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Total users</div>
          <div className="text-2xl font-bold">{data.users.total}</div>
          <div className="text-xs opacity-50">{data.users.active} active · {data.users.suspended} suspended</div>
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Transactions (24h)</div>
          <div className="text-2xl font-bold">{data.transactions.last24h}</div>
          <div className="text-xs opacity-50">{data.transactions.total} total</div>
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Volume (24h XLM)</div>
          <div className="text-2xl font-bold">{data.transactions.last24hVolumeXlm.toFixed(2)}</div>
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="text-xs opacity-60">Total volume (XLM)</div>
          <div className="text-2xl font-bold">{data.transactions.totalVolumeXlm.toFixed(2)}</div>
        </div>
      </div>
      <div>
        <div className="text-xs opacity-60 mb-1">Users by role</div>
        <div className="flex flex-wrap gap-2">
          {data.roles.map((r) => (
            <span key={r.role} className="rounded-full border border-white/10 px-3 py-0.5 text-xs">
              {r.role}: {r.count}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── User management panel ────────────────────────────────────────────────────

type UserRecord = {
  id: string;
  walletAddress: string;
  status: "active" | "suspended";
  role: string;
  registeredAt: string;
  suspendedAt: string | null;
  suspendReason: string | null;
};

function UserManagementPanel() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: "10" });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`${API}/api/admin/dashboard/users?${params}`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    setUsers(data.users ?? []);
    setTotal(data.total ?? 0);
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function handleSuspend(userId: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API}/api/admin/dashboard/users/${userId}/suspend`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: "Admin action" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg({ kind: "ok", text: `User ${userId} suspended` });
      await load();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnsuspend(userId: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API}/api/admin/dashboard/users/${userId}/unsuspend`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg({ kind: "ok", text: `User ${userId} unsuspended` });
      await load();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">User Management</h2>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-white/10 bg-transparent px-3 py-1 text-xs"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      {msg && <p className={`text-xs mb-2 ${msg.kind === "ok" ? "text-green-400" : "text-red-400"}`}>{msg.text}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase opacity-60">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">Wallet</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Registered</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-center opacity-60">No users found.</td></tr>
            )}
            {users.map((u) => (
              <tr key={u.id} className="border-t border-white/5 hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-xs opacity-70">{u.id}</td>
                <td className="px-3 py-2 font-mono text-xs">{u.walletAddress.slice(0, 12)}…</td>
                <td className="px-3 py-2 capitalize">{u.role}</td>
                <td className={`px-3 py-2 capitalize font-medium ${u.status === "active" ? "text-green-400" : "text-red-400"}`}>
                  {u.status}
                </td>
                <td className="px-3 py-2 text-xs opacity-60">{new Date(u.registeredAt).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-right">
                  {u.status === "active" ? (
                    <button
                      onClick={() => handleSuspend(u.id)}
                      disabled={busy}
                      className="text-xs text-gray-400 hover:text-red-400 border border-white/10 rounded px-2 py-0.5"
                    >
                      Suspend
                    </button>
                  ) : (
                    <button
                      onClick={() => handleUnsuspend(u.id)}
                      disabled={busy}
                      className="text-xs text-gray-400 hover:text-green-400 border border-white/10 rounded px-2 py-0.5"
                    >
                      Unsuspend
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs opacity-60">
        <span>{total} total users</span>
        <div className="flex gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-0.5 border border-white/10 rounded disabled:opacity-30">←</button>
          <span>Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={users.length < 10} className="px-2 py-0.5 border border-white/10 rounded disabled:opacity-30">→</button>
        </div>
      </div>
    </div>
  );
}

// ── Transaction audit log ────────────────────────────────────────────────────

type TxRecord = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  timestamp: string;
  meterId: string | null;
};

function TransactionAuditLog() {
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: "10" });
    const res = await fetch(`${API}/api/admin/dashboard/transactions?${params}`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    setTxs(data.transactions ?? []);
    setTotal(data.total ?? 0);
  }, [page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h2 className="text-lg font-semibold mb-3">Transaction Audit Log</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase opacity-60">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Time</th>
            </tr>
          </thead>
          <tbody>
            {txs.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-center opacity-60">No transactions recorded.</td></tr>
            )}
            {txs.map((t) => (
              <tr key={t.id} className="border-t border-white/5 hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-xs opacity-70">{t.id}</td>
                <td className="px-3 py-2 font-mono text-xs">{t.userId.slice(0, 10)}…</td>
                <td className="px-3 py-2 capitalize">{t.type}</td>
                <td className="px-3 py-2 text-right tabular-nums">{t.amount.toFixed(2)} {t.currency}</td>
                <td className={`px-3 py-2 capitalize ${t.status === "settled" ? "text-green-400" : t.status === "failed" ? "text-red-400" : "text-yellow-400"}`}>
                  {t.status}
                </td>
                <td className="px-3 py-2 text-xs opacity-60">{new Date(t.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-3 text-xs opacity-60">
        <span>{total} total transactions</span>
        <div className="flex gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-0.5 border border-white/10 rounded disabled:opacity-30">←</button>
          <span>Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={txs.length < 10} className="px-2 py-0.5 border border-white/10 rounded disabled:opacity-30">→</button>
        </div>
      </div>
    </div>
  );
}

// ── Main admin page ──────────────────────────────────────────────────────────

type AdminTab = "overview" | "users" | "transactions" | "system" | "caps";

export default function AdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  useEffect(() => {
    if (!sessionStorage.getItem("admin_token")) {
      router.replace("/admin/login");
    } else {
      setReady(true);
    }
  }, [router]);

  function handleLogout() {
    sessionStorage.removeItem("admin_token");
    router.replace("/admin/login");
  }

  if (!ready) return null;

  const TABS: { key: AdminTab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "users", label: "Users" },
    { key: "transactions", label: "Transactions" },
    { key: "system", label: "System Health" },
    { key: "caps", label: "Usage Caps" },
  ];

  return (
    <>
      <Navbar />
      <main className="min-h-screen px-4 py-8 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-solar-yellow">Admin Dashboard</h1>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-red-400 border border-white/10 rounded-lg px-3 py-1.5 transition"
          >
            Sign Out
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mb-6 border-b border-white/10 pb-3">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === t.key
                  ? "bg-solar-yellow text-solar-dark"
                  : "border border-white/10 text-gray-400 hover:text-white hover:border-white/20"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-6">
          {activeTab === "overview" && (
            <>
              <AnalyticsPanel />
              <SystemHealthPanel />
            </>
          )}
          {activeTab === "users" && <UserManagementPanel />}
          {activeTab === "transactions" && <TransactionAuditLog />}
          {activeTab === "system" && <SystemHealthPanel />}
          {activeTab === "caps" && <DailyCapForm />}
        </div>
      </main>
    </>
  );
}
