"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Skeleton } from "@/components/Skeleton";
import UsageChart, { type UsageDataPoint } from "@/components/UsageChart";
import UsageForecast from "@/components/UsageForecast";
import { MeterSearchBar, type StatusFilter } from "@/components/MeterSearchBar";
import { fuzzyMatch } from "@/lib/fuzzySearch";
import { useWalletStore } from "@/store/walletStore";
import { getMeter, getMetersByOwner, type MeterData } from "@/services/meterService";
import { parseWalletError } from "@/lib/errors";
import { useToast } from "@/components/ToastProvider";
import { useInterval } from "@/hooks/useInterval";
import {
  requestPushPermissionOnFirstDashboardVisit,
  setupLowBalancePushNotifications,
} from "@/services/pushService";
import { env } from "@/lib/env";
import { formatXLM } from "@/lib/format";
import PaymentSchedule from "@/components/PaymentSchedule";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const BALANCE_POLL_INTERVAL_MS = env.NEXT_PUBLIC_POLL_INTERVAL_MS;

function stroopsToXlm(stroops: bigint): string {
  return formatXLM(stroops);
}

interface PaymentRecord {
  transaction_hash?: string;
  transactionHash?: string;
  hash?: string;
  created_at?: string;
  date?: string;
  timestamp?: string;
  meter_id?: string;
  meterId?: string;
  amount_stroops?: string | number;
  amountStroops?: string | number;
  amount?: string | number;
  payment_plan?: string;
  plan?: string;
  status?: string;
  payment_status?: string;
}

function getPaymentHash(record: PaymentRecord): string {
  return record.transaction_hash ?? record.transactionHash ?? record.hash ?? "";
}

function getPaymentDate(record: PaymentRecord): string {
  const raw = record.created_at ?? record.date ?? record.timestamp;
  if (!raw) return "";
  const date = new Date(raw);
  return isNaN(date.getTime()) ? String(raw) : date.toISOString();
}

function getPaymentAmountXlm(record: PaymentRecord): string {
  const value = record.amount_stroops ?? record.amountStroops ?? record.amount;
  if (value === undefined || value === null) return "";
  try {
    return formatXLM(BigInt(value));
  } catch {
    return Number(value).toString();
  }
}

function getPaymentPlan(record: PaymentRecord): string {
  return record.payment_plan ?? record.plan ?? "";
}

function getPaymentStatus(record: PaymentRecord): string {
  return record.status ?? record.payment_status ?? "";
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function paymentsToCsv(payments: PaymentRecord[]): string {
  const header = ["Transaction Hash", "Date", "Meter ID", "Amount (XLM)", "Payment Plan", "Status"];
  const rows = payments.map((payment) =>
    [
      getPaymentHash(payment),
      getPaymentDate(payment),
      payment.meter_id ?? payment.meterId ?? "",
      getPaymentAmountXlm(payment),
      getPaymentPlan(payment),
      getPaymentStatus(payment),
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function downloadPaymentsCsv(meterIds: string[]) {
  try {
    const query = new URLSearchParams(window.location.search).toString();
    const allPayments: PaymentRecord[] = [];
    for (const meterId of meterIds) {
      const res = await fetch(`${API}/api/meters/${encodeURIComponent(meterId)}/payments${query ? `?${query}` : ""}`);
      if (!res.ok) continue;
      const data = await res.json();
      const payments: PaymentRecord[] = Array.isArray(data) ? data : data?.payments ?? [];
      allPayments.push(...payments);
    }
    downloadCsv(`payment-history.csv`, paymentsToCsv(allPayments));
  } catch (err) {
    console.error("Failed to export payment history:", err);
  }
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${active
        ? "border-green-600/40 bg-green-900/30 text-green-400"
        : "border-red-600/40 bg-red-900/30 text-red-400"
        }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-green-400" : "bg-red-400"}`} />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const styles: Record<string, string> = {
    Daily: "bg-blue-900/40 text-blue-300 border-blue-700/40",
    Weekly: "bg-purple-900/40 text-purple-300 border-purple-700/40",
    Monthly: "bg-amber-900/40 text-amber-300 border-amber-700/40",
    UsageBased: "bg-green-900/40 text-green-300 border-green-700/40",
    Usage: "bg-green-900/40 text-green-300 border-green-700/40",
  };
  const cls = styles[plan] ?? "bg-gray-800 text-gray-400 border-gray-700/40";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>{plan}</span>
  );
}

/**
 * Daily usage cap status (closes #758): shows plain progress under 80%,
 * an amber alert at 80-99%, and a red alert once the cap is reached — with
 * different copy depending on whether the meter auto-deactivates or only
 * warns when the cap is hit.
 */
function DailyCapAlert({
  daySpent,
  dailyLimit,
  autoDeactivate,
}: {
  daySpent: bigint;
  dailyLimit: bigint;
  autoDeactivate: boolean;
}) {
  if (dailyLimit <= 0n) return null;
  const ratio = Number(daySpent) / Number(dailyLimit);
  const percent = Math.min(999, Math.round(ratio * 100));
  const reached = ratio >= 1;
  const approaching = !reached && ratio >= 0.8;

  if (!reached && !approaching) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="uppercase tracking-wider">Daily cap</span>
        <span>
          {stroopsToXlm(daySpent)} / {stroopsToXlm(dailyLimit)} XLM ({percent}%)
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={`rounded-lg border p-3 text-xs flex items-start gap-2 ${
        reached
          ? "border-red-600/40 bg-red-950/40 text-red-300"
          : "border-amber-500/40 bg-amber-950/40 text-amber-300"
      }`}
    >
      <span className="mt-0.5" aria-hidden="true">{reached ? "🛑" : "⚠️"}</span>
      {reached ? (
        <p>
          <strong>Daily cap reached</strong> ({percent}% of {stroopsToXlm(dailyLimit)} XLM/day).{" "}
          {autoDeactivate
            ? "Usage is paused until the cap resets at midnight UTC."
            : "Meter keeps running (warn-only mode)."}
        </p>
      ) : (
        <p>
          Approaching daily cap — <strong>{percent}%</strong> of {stroopsToXlm(dailyLimit)} XLM used today.
        </p>
      )}
    </div>
  );
}

function ErrorCard({ meterId, error }: { meterId: string; error: string }) {
  return (
    <div className="rounded-xl border border-red-500/40 bg-red-900/20 p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-red-400 font-semibold">{meterId}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-600/40 bg-red-900/30 px-3 py-1 text-xs font-semibold text-red-400">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
          Error
        </span>
      </div>

      {/* Error message */}
      <div className="rounded-lg border border-red-600/40 bg-red-900/20 p-3 text-red-300 text-sm">
        <p>Failed to load meter data: {error}</p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => window.location.reload()} // Simple retry, or could call fetchAll for specific meter
          className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 transition"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function CountdownTimer({ expiresAt, plan }: { expiresAt: bigint; plan: string }) {
  const isTimedPlan = plan === "Daily" || plan === "Weekly" || plan === "Monthly";
  const expSec = Number(expiresAt);
  const hasExpiry = expSec > 0 && expSec !== Number.MAX_SAFE_INTEGER;

  const [remaining, setRemaining] = useState(() =>
    isTimedPlan && hasExpiry ? Math.max(0, expSec - Math.floor(Date.now() / 1000)) : -1,
  );

  useEffect(() => {
    if (!isTimedPlan || !hasExpiry) return;
    const tick = () => setRemaining(Math.max(0, expSec - Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isTimedPlan, hasExpiry, expSec]);

  if (!isTimedPlan || !hasExpiry || remaining < 0) return null;

  if (remaining === 0) {
    return <span className="text-xs font-semibold text-red-400">Expired</span>;
  }

  const h = Math.floor(remaining / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((remaining % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = (remaining % 60).toString().padStart(2, "0");

  return (
    <span className="text-xs font-mono text-solar-yellow">
      {h}:{m}:{s}
    </span>
  );
}

const COMMON_EMOJIS = ["☀️", "🏠", "🏬", "⚡", "🔋", "🏭"];

// ---- Meter grouping & tagging (Issue #732) ----
const GROUPS_STORAGE_KEY = "meter_groups_v1";
const TAGS_STORAGE_KEY = "meter_tags_v1";
const MAX_GROUPS = 20;
const MAX_TAGS_PER_METER = 20;

interface MeterGroup {
  id: string;
  name: string;
  color: string;
  meterIds: string[];
}

type TagMap = Record<string, string[]>;

const GROUP_COLORS = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadGroups(): Record<string, MeterGroup> {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, MeterGroup>) : {};
  } catch {
    return {};
  }
}

function saveGroups(groups: Record<string, MeterGroup>) {
  try {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // LocalStorage might be unavailable
  }
}

function loadTags(): TagMap {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TagMap) : {};
  } catch {
    return {};
  }
}

function saveTags(tags: TagMap) {
  try {
    localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch {
    // LocalStorage might be unavailable
  }
}

function MeterCard({
  meterId,
  meter,
  tags,
  onAddTag,
  onRemoveTag,
}: {
  meterId: string;
  meter: MeterData;
  tags?: string[];
  onAddTag?: (meterId: string, tag: string) => void;
  onRemoveTag?: (meterId: string, tag: string) => void;
}) {
  const [nickname, setNickname] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [tempNickname, setTempNickname] = useState("");
  const [tempTag, setTempTag] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`meter_nickname_${meterId}`);
      if (saved) {
        setNickname(saved);
        setTempNickname(saved);
      }
    } catch {
      // LocalStorage might be unavailable
    }
  }, [meterId]);

  const handleSaveNickname = () => {
    const trimmed = tempNickname.trim().slice(0, 30);
    setNickname(trimmed);
    setIsEditing(false);
    try {
      if (trimmed) {
        localStorage.setItem(`meter_nickname_${meterId}`, trimmed);
      } else {
        localStorage.removeItem(`meter_nickname_${meterId}`);
      }
    } catch {
      // Ignore storage errors
    }
  };

  const handleCancelNickname = () => {
    setTempNickname(nickname);
    setIsEditing(false);
  };

  const now = Date.now() / 1000; // Current time in seconds
  const expiresAt = Number(meter.expires_at);
  const isExpired = expiresAt !== Number.MAX_SAFE_INTEGER && expiresAt > 0 && now >= expiresAt;
  const hasAccess = meter.active && meter.balance > 0n && !isExpired;

  const [history, setHistory] = useState<UsageDataPoint[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  useEffect(() => {
    setLoadingHistory(true);
    fetch(`${API}/api/meters/${meterId}/history?page=1&pageSize=100`)
      .then((r) => r.json())
      .then((d) => {
        // Pass the raw ISO 8601 timestamp through — UsageChart formats it in
        // the viewer's local timezone (with a timezone indicator) itself, so
        // pre-formatting here would throw away the time-of-day and tz info.
        const events: UsageDataPoint[] = (d.events || []).map(
          (e: { received_at?: string; recorded_at?: string; units: number; cost?: number }) => ({
            date: e.received_at ?? e.recorded_at ?? "",
            units: e.units,
            cost: e.cost,
          }),
        );
        setHistory(events);
        setLoadingHistory(false);
      })
      .catch(() => {
        setHistory([]);
        setLoadingHistory(false);
      });
  }, [meterId]);

  // Format expiry date
  const formatExpiry = () => {
    if (meter.plan === "UsageBased" || expiresAt === Number.MAX_SAFE_INTEGER) {
      return "Never (Usage-based)";
    }
    if (expiresAt === 0) return "—";
    const date = new Date(expiresAt * 1000);
    if (isExpired) return `Expired ${date.toLocaleDateString()}`;
    return date.toLocaleDateString();
  };

  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          {nickname ? (
            <div>
              <div className="flex items-center gap-1.5 group">
                <h3 className="font-semibold text-white text-base truncate">{nickname}</h3>
                {!isEditing && (
                  <button
                    onClick={() => {
                      setTempNickname(nickname);
                      setIsEditing(true);
                    }}
                    className="text-gray-400 hover:text-solar-yellow text-xs opacity-70 group-hover:opacity-100 transition"
                    title="Edit nickname"
                    aria-label="Edit nickname"
                  >
                    ✏️
                  </button>
                )}
              </div>
              <span className="font-mono text-xs text-gray-400 truncate block mt-0.5">
                {meterId}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-solar-yellow font-semibold">{meterId}</span>
              {!isEditing && (
                <button
                  onClick={() => {
                    setTempNickname("");
                    setIsEditing(true);
                  }}
                  className="text-xs text-gray-400 hover:text-solar-yellow underline transition"
                >
                  Set nickname
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge active={hasAccess} />
          <PlanBadge plan={meter.plan} />
        </div>
      </div>

      {/* Nickname Editor */}
      {isEditing && (
        <div className="rounded-lg bg-solar-dark/50 border border-white/10 p-3 space-y-2">
          <label className="text-xs text-gray-400 block">Set nickname (max 30 chars)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              maxLength={30}
              value={tempNickname}
              onChange={(e) => setTempNickname(e.target.value)}
              placeholder="e.g. Home Solar ☀️"
              className="flex-1 rounded border border-white/20 bg-solar-dark px-2.5 py-1 text-xs text-white placeholder-gray-500 focus:border-solar-yellow focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveNickname();
                if (e.key === "Escape") handleCancelNickname();
              }}
            />
            <button
              onClick={handleSaveNickname}
              className="rounded bg-solar-yellow px-2.5 py-1 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Save
            </button>
            <button
              onClick={handleCancelNickname}
              className="rounded border border-white/20 px-2 py-1 text-xs text-gray-400 hover:text-white transition"
            >
              Cancel
            </button>
          </div>
          {/* Quick Emoji Picker */}
          <div className="flex items-center gap-1.5 pt-1">
            <span className="text-[10px] text-gray-500">Quick emojis:</span>
            {COMMON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  if (tempNickname.length + emoji.length <= 30) {
                    setTempNickname((prev) => (prev ? `${prev} ${emoji}` : emoji).slice(0, 30));
                  }
                }}
                className="rounded px-1.5 py-0.5 text-xs hover:bg-white/10 transition"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Balance", value: `${stroopsToXlm(meter.balance)} XLM` },
          { label: "Units Used", value: `${Number(meter.units_used) / 1000} kWh` },
          {
            label: "Last Payment",
            value:
              meter.last_payment > 0n
                ? new Date(Number(meter.last_payment) * 1000).toLocaleDateString()
                : "—",
          },
          { label: "Expires", value: formatExpiry() },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
            <span
              className={`text-sm font-semibold truncate ${label === "Expires" && isExpired ? "text-red-400" : "text-white"}`}
            >
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Countdown timer for time-based plans */}
      {(meter.plan === "Daily" || meter.plan === "Weekly") && (
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">Time Remaining</span>
          <CountdownTimer expiresAt={meter.expires_at} plan={meter.plan} />
        </div>
      )}

      {/* Warning for grace period, expired, or low balance */}
      {meter.grace_expires_at && Number(meter.grace_expires_at) > now ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/40 p-3 text-amber-300 text-xs flex items-start gap-2">
          <span className="mt-0.5">⚠️</span>
          <p>
            Meter is in <strong>grace period</strong> until{" "}
            {new Date(Number(meter.grace_expires_at) * 1000).toLocaleTimeString()}. Top up your
            balance to avoid disconnection!
          </p>
        </div>
      ) : isExpired || meter.balance === 0n ? (
        <div className="rounded-lg border border-yellow-600/40 bg-yellow-900/20 p-3 text-yellow-300 text-xs flex items-start gap-2">
          <span className="mt-0.5">⚠</span>
          <p>
            {isExpired && "Your plan has expired. "}
            {meter.balance === 0n && "Your balance is zero. "}
            Top up to restore access.
          </p>
        </div>
      ) : null}

      {/* Daily usage cap status */}
      {typeof meter.daily_limit === "bigint" && meter.daily_limit > 0n && (
        <DailyCapAlert
          daySpent={meter.day_spent ?? 0n}
          dailyLimit={meter.daily_limit}
          autoDeactivate={meter.auto_deactivate ?? true}
        />
      )}

      {/* Usage Forecasting */}
      <UsageForecast
        meterId={meterId}
        balance={meter.balance}
        history={history}
        loading={loadingHistory}
      />

      {/* Energy Insights */}
      <EnergyInsights meterId={meterId} />

      {/* Usage History Chart */}
      <div className="pt-4 border-t border-white/10">
        <UsageChart data={history} loading={loadingHistory} meterId={meterId} />
      </div>

      {/* Payment Schedule — closes #746 */}
      <div className="pt-4 border-t border-white/10">
        <PaymentSchedule meterId={meterId} />
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Link
          href={`/pay?meter=${meterId}`}
          className="rounded-lg bg-solar-yellow px-4 py-2 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
        >
          Top Up
        </Link>
        <Link
          href={`/history?meterId=${meterId}`}
          className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
        >
          View history
        </Link>
      </div>
    </div>
  );
}

function GroupStats({ members }: { members: MeterData[] }) {
  const total = members.length;
  if (total === 0) return null;
  const activeCount = members.filter((m) => m.active).length;
  const balanceSum = members.reduce((acc, m) => acc + (m.balance > 0n ? m.balance : 0n), 0n);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
      <span>
        <span className="text-white font-semibold">{activeCount}</span>/{total} active
      </span>
      <span className="flex items-center gap-1">
        <span className="text-white font-semibold">{stroopsToXlm(balanceSum)}</span> XLM total
      </span>
    </div>
  );
}

function GroupCard({
  title,
  color,
  members,
  meters,
  failedMeters,
  tags,
  onAddTag,
  onRemoveTag,
  onRemoveMeter,
  collapsed,
  onToggle,
}: {
  title: string;
  color?: string;
  members: string[];
  meters: Record<string, MeterData>;
  failedMeters: Record<string, string>;
  tags: TagMap;
  onAddTag: (meterId: string, tag: string) => void;
  onRemoveTag: (meterId: string, tag: string) => void;
  onRemoveMeter: (meterId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const meterData = members
    .map((id) => ({ id, data: meters[id] }))
    .filter((x) => x.data || failedMeters[x.id]);
  const activeData = meterData.map((x) => x.data).filter((d): d is MeterData => Boolean(d));

  return (
    <div className="rounded-xl border border-white/10 bg-solar-accent/60 overflow-hidden">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/5 transition"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-2 min-w-0">
          {color && (
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
          )}
          <span className="font-semibold text-white truncate">{title}</span>
          <span className="text-xs text-gray-500">({members.length})</span>
        </div>
        <span
          className="text-gray-400 text-xs transition-transform"
          style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
        >
          ▾
        </span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-4">
          <GroupStats members={activeData} />
          {meterData.length === 0 ? (
            <p className="text-xs text-gray-500">No meters in this group.</p>
          ) : (
            meterData.map(({ id, data }) =>
              data ? (
                <MeterCard
                  key={id}
                  meterId={id}
                  meter={data}
                  tags={tags[id] ?? []}
                  onAddTag={onAddTag}
                  onRemoveTag={onRemoveTag}
                />
              ) : (
                <div key={id} className="relative">
                  <ErrorCard meterId={id} error={failedMeters[id] ?? "Unknown error"} />
                  <button
                    type="button"
                    onClick={() => onRemoveMeter(id)}
                    className="absolute top-2 right-2 rounded-full border border-white/10 px-2 py-0.5 text-xs text-gray-400 hover:text-red-400 hover:border-red-500/40 transition"
                    title="Remove from group (not from your account)"
                  >
                    Ungroup
                  </button>
                </div>
              ),
            )
          )}
          {members.length > 1 && (
            <button
              type="button"
              onClick={() => members.forEach(onRemoveMeter)}
              className="text-xs text-gray-500 underline underline-offset-2 hover:text-red-400 transition"
            >
              Remove all meters from this group
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function UserDashboardPage() {
  const { address, connect } = useWalletStore();
  const { showToast } = useToast();

  const [meterIds, setMeterIds] = useState<string[]>([]);
  const [meters, setMeters] = useState<Record<string, MeterData>>({});
  const [failedMeters, setFailedMeters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  // Meter grouping & tagging (Issue #732).
  const [groups, setGroups] = useState<Record<string, MeterGroup>>({});
  const [tags, setTags] = useState<TagMap>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const fetchAll = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const ids = await getMetersByOwner(address);
      setMeterIds(ids);
      const metersMap: Record<string, MeterData> = {};
      const failedMap: Record<string, string> = {};
      for (const id of ids) {
        try {
          const meter = await getMeter(id);
          metersMap[id] = meter;
        } catch (err: unknown) {
          const friendly = parseWalletError(err);
          failedMap[id] = friendly;
          showToast({
            variant: "error",
            title: `Failed to load meter ${id}`,
            description: friendly,
          });
        }
      }
      setMeters(metersMap);
      setFailedMeters(failedMap);
      if (Object.keys(failedMap).length > 0) {
        setError(`Some meters failed to load. Check individual meter cards for details.`);
      }
      setLastRefresh(new Date());
    } catch (err: unknown) {
      const friendly = parseWalletError(err);
      setError(friendly);
      showToast({
        variant: "error",
        title: "Failed to load meters",
        description: friendly,
      });
    } finally {
      setLoading(false);
    }
  }, [address, showToast]);

  // Initial fetch when wallet connects / address changes
  useEffect(() => {
    if (!address) {
      setMeterIds([]);
      setMeters({});
      setFailedMeters({});
      setError(null);
      setLastRefresh(null);
      return;
    }
    fetchAll();
  }, [address, fetchAll]);

  useEffect(() => {
    if (!address) return;
    requestPushPermissionOnFirstDashboardVisit().catch(() => {
      // Permission API might fail on unsupported browser modes.
    });
  }, [address]);

  // Load persisted groups/tags once on mount.
  useEffect(() => {
    setGroups(loadGroups());
    setTags(loadTags());
  }, []);

  const persistGroups = (next: Record<string, MeterGroup>) => {
    setGroups(next);
    saveGroups(next);
  };

  const persistTags = (next: TagMap) => {
    setTags(next);
    saveTags(next);
  };

  const createGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    if (Object.keys(groups).length >= MAX_GROUPS) return;
    const id = uid();
    const color = GROUP_COLORS[Object.keys(groups).length % GROUP_COLORS.length];
    persistGroups({ ...groups, [id]: { id, name, color, meterIds: [] } });
    setNewGroupName("");
  };

  const deleteGroup = (id: string) => {
    const next = { ...groups };
    delete next[id];
    persistGroups(next);
    if (groupFilter === id) setGroupFilter(null);
  };

  const addMeterToGroup = (groupId: string, meterId: string) => {
    const g = groups[groupId];
    if (!g || g.meterIds.includes(meterId)) return;
    // A meter belongs to at most one group; remove it from any others.
    const next: Record<string, MeterGroup> = {};
    for (const [id, grp] of Object.entries(groups)) {
      next[id] = { ...grp, meterIds: grp.meterIds.filter((m) => m !== meterId) };
    }
    next[groupId] = { ...next[groupId], meterIds: [...next[groupId].meterIds, meterId] };
    persistGroups(next);
  };

  const removeMeterFromGroup = (meterId: string) => {
    const next: Record<string, MeterGroup> = {};
    for (const [id, grp] of Object.entries(groups)) {
      next[id] = { ...grp, meterIds: grp.meterIds.filter((m) => m !== meterId) };
    }
    persistGroups(next);
  };

  const addTag = (meterId: string, tag: string) => {
    const current = tags[meterId] ?? [];
    if (current.includes(tag) || current.length >= MAX_TAGS_PER_METER) return;
    persistTags({ ...tags, [meterId]: [...current, tag] });
  };

  const removeTag = (meterId: string, tag: string) => {
    persistTags({ ...tags, [meterId]: (tags[meterId] ?? []).filter((t) => t !== tag) });
  };

  const toggleCollapse = (id: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Which meters are visible under the active group/tag filters.
  const visibleMeterIds = meterIds.filter((id) => {
    if (groupFilter) {
      const g = groups[groupFilter];
      if (!g || !g.meterIds.includes(id)) return false;
    }
    if (tagFilter && !(tags[id] ?? []).includes(tagFilter)) return false;
    return true;
  });

  const allTags = [...new Set(Object.values(tags).flatMap((arr) => arr))].sort();

  // Grouped presentation for the meter list (Issue #732).
  const inAnyGroup = new Set(Object.values(groups).flatMap((g) => g.meterIds));
  const visibleGroups = Object.values(groups)
    .map((g) => ({ group: g, members: g.meterIds.filter((id) => visibleMeterIds.includes(id)) }))
    .filter((x) => x.members.length > 0);
  const ungroupedIds = visibleMeterIds.filter((id) => !inAnyGroup.has(id));

  // Poll individual meter balances for live updates.
  // useInterval does NOT fire on mount, so fetchAll() above handles the
  // first load — no double-fetch on first render.
  const pollBalances = useCallback(async () => {
    if (!address || meterIds.length === 0) return;
    let anyChanged = false;
    for (const id of meterIds) {
      try {
        const res = await fetch(`${API}/api/meters/${id}/balance`);
        if (!res.ok) continue;
        const data = await res.json();
        setMeters((prev) => {
          const existing = prev[id];
          if (!existing) return prev;
          const nextBal = BigInt(data.balance ?? existing.balance);
          const nextUnits = data.units_used ?? existing.units_used;
          const nextActive = data.active ?? existing.active;

          if (
            existing.balance === nextBal &&
            existing.units_used === nextUnits &&
            existing.active === nextActive
          ) {
            return prev;
          }

          anyChanged = true;
          return {
            ...prev,
            [id]: {
              ...existing,
              balance: nextBal,
              units_used: nextUnits,
              active: nextActive,
            },
          };
        });

        const threshold = Number(data.low_balance_threshold_stroops ?? 0);
        const currentBalance = Number(data.balance ?? 0);
        if (threshold > 0 && currentBalance <= threshold) {
          setupLowBalancePushNotifications(address).catch(() => {
            // Avoid interrupting dashboard polling if push setup fails.
          });
        }
      } catch {
        // Silently skip — full refresh will recover on next interval
      }
    }
    if (anyChanged) {
      setLastRefresh(new Date());
    }
  }, [address, meterIds]);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const filteredMeterIds = meterIds.filter((id) => {
    const meter = meters[id];
    let nickname = "";
    try {
      nickname = localStorage.getItem(`meter_nickname_${id}`) || "";
    } catch {
      // LocalStorage error fallback
    }

    const status = meter ? (meter.active ? "active" : "inactive") : "";
    const location = (meter as any)?.location || "";

    if (statusFilter === "active" && meter && !meter.active) return false;
    if (statusFilter === "inactive" && meter && meter.active) return false;

    if (!searchQuery.trim()) return true;

    return (
      fuzzyMatch(id, searchQuery) ||
      fuzzyMatch(nickname, searchQuery) ||
      fuzzyMatch(location, searchQuery) ||
      fuzzyMatch(status, searchQuery)
    );
  });

  // Pause polling when address is gone or no meters loaded yet
  useInterval(pollBalances, address && meterIds.length > 0 ? BALANCE_POLL_INTERVAL_MS : null);

  return (
    <ErrorBoundary>
      <Navbar />
      <main id="main-content" tabIndex={-1} className="min-h-screen px-4 py-8 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-solar-yellow">My Meters</h1>
            {lastRefresh && (
              <p className="text-xs text-gray-500 mt-0.5">
                Last updated {lastRefresh.toLocaleTimeString()}
              </p>
            )}
          </div>
          {address && (
            <button
              onClick={fetchAll}
              disabled={loading}
              className="self-start sm:self-auto rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {loading ? "Refreshing…" : "↻ Refresh"}
            </button>
          )}
          {address && meterIds.length > 0 && (
            <button
              onClick={() => downloadPaymentsCsv(meterIds)}
              className="self-start sm:self-auto rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
            >
              Download CSV
            </button>
          )}
        </div>

        {/* Grouping / tagging controls (Issue #732) */}
        {address && meterIds.length > 0 && (
          <div className="mb-6 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowGroupManager((v) => !v)}
                className="rounded-lg bg-solar-yellow px-3 py-1.5 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
              >
                {showGroupManager ? "Done" : "+ Groups"}
              </button>

              <select
                value={groupFilter ?? ""}
                onChange={(e) => setGroupFilter(e.target.value || null)}
                className="rounded-lg border border-white/15 bg-solar-dark px-2.5 py-1.5 text-xs text-white focus:border-solar-yellow focus:outline-none"
                aria-label="Filter by group"
              >
                <option value="">All groups</option>
                {Object.values(groups).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.meterIds.length})
                  </option>
                ))}
              </select>

              <select
                value={tagFilter ?? ""}
                onChange={(e) => setTagFilter(e.target.value || null)}
                className="rounded-lg border border-white/15 bg-solar-dark px-2.5 py-1.5 text-xs text-white focus:border-solar-yellow focus:outline-none"
                aria-label="Filter by tag"
              >
                <option value="">All tags</option>
                {allTags.map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </select>

              {(groupFilter || tagFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setGroupFilter(null);
                    setTagFilter(null);
                  }}
                  className="text-xs text-gray-400 underline underline-offset-2 hover:text-solar-yellow transition"
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* Group manager panel */}
            {showGroupManager && (
              <div className="rounded-xl border border-white/10 bg-solar-accent p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newGroupName}
                    maxLength={30}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createGroup();
                    }}
                    placeholder="New group name (e.g. Shop)"
                    className="flex-1 rounded border border-white/20 bg-solar-dark px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:border-solar-yellow focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={createGroup}
                    disabled={!newGroupName.trim() || Object.keys(groups).length >= MAX_GROUPS}
                    className="rounded bg-solar-yellow px-3 py-1.5 text-xs font-semibold text-solar-dark hover:opacity-90 disabled:opacity-40 transition"
                  >
                    Create
                  </button>
                </div>

                {Object.keys(groups).length === 0 ? (
                  <p className="text-xs text-gray-500">
                    No groups yet. Create a group, then assign meters to it below.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {Object.values(groups).map((g) => (
                      <div
                        key={g.id}
                        className="rounded-lg border border-white/10 bg-solar-dark/50 p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="inline-block h-3 w-3 shrink-0 rounded-full"
                              style={{ backgroundColor: g.color }}
                            />
                            <span className="text-sm font-semibold text-white truncate">
                              {g.name}
                            </span>
                            <span className="text-xs text-gray-500">({g.meterIds.length})</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteGroup(g.id)}
                            className="text-xs text-gray-400 hover:text-red-400 transition"
                          >
                            Delete
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] uppercase tracking-wider text-gray-500">
                            Add meter:
                          </span>
                          {meterIds
                            .filter((id) => !g.meterIds.includes(id))
                            .slice(0, 20)
                            .map((id) => (
                              <button
                                key={id}
                                type="button"
                                onClick={() => addMeterToGroup(g.id, id)}
                                className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-mono text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
                              >
                                + {id}
                              </button>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Not connected */}
        {!address && (
          <div className="rounded-xl border border-white/10 bg-solar-accent p-10 text-center">
            <p className="text-gray-400 mb-5">Connect your wallet to view your meters.</p>
            <button
              onClick={connect}
              className="rounded-lg bg-solar-yellow px-6 py-2.5 font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Connect Wallet
            </button>
          </div>
        )}

        {/* Error */}
        {address && error && (
          <div className="rounded-lg border border-red-500/40 bg-red-900/20 p-4 text-red-400 text-sm mb-6 flex items-start gap-3">
            <span className="mt-0.5">✕</span>
            <div>
              <p className="font-semibold mb-1">Failed to load meters</p>
              <p>{error}</p>
              <button
                onClick={fetchAll}
                className="mt-3 text-xs underline underline-offset-2 hover:text-red-300 transition"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Loading skeleton */}
        {address && loading && meterIds.length === 0 && (
          <div className="space-y-4">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-white/10 bg-solar-accent p-4 sm:p-5 space-y-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <Skeleton width="30%" height={16} />
                  <Skeleton width="20%" height={24} />
                </div>
                <div className="grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-4 gap-3">
                  {[1, 2, 3, 4].map((j) => (
                    <div key={j} className="flex flex-col gap-1">
                      <Skeleton width="60%" height={10} />
                      <Skeleton height={16} />
                    </div>
                  ))}
                </div>
                <Skeleton height={40} />
              </div>
            ))}
          </div>
        )}

        {/* No meters */}
        {address && !loading && !error && meterIds.length === 0 && (
          <div className="rounded-xl border border-white/10 bg-solar-accent p-10 text-center text-gray-400 text-sm">
            No meters registered to this address.
          </div>
        )}

        {/* Search bar and filter pills */}
        {address && meterIds.length > 0 && (
          <MeterSearchBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            totalCount={meterIds.length}
            filteredCount={filteredMeterIds.length}
          />
        )}

        {/* No search results */}
        {address && meterIds.length > 0 && filteredMeterIds.length === 0 && (
          <div className="rounded-xl border border-white/10 bg-solar-accent p-8 text-center text-gray-400">
            <p className="text-base font-semibold text-white mb-1">No matching meters found</p>
            <p className="text-xs text-gray-400 mb-4">
              No meters match your search &ldquo;{searchQuery}&rdquo;
              {statusFilter !== "all" ? ` with status &ldquo;${statusFilter}&rdquo;` : ""}.
            </p>
            <button
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
              }}
              aria-label="Clear all filters"
              className="rounded-lg bg-solar-yellow px-4 py-1.5 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Clear Search &amp; Filters
            </button>
          </div>
        )}

        {/* Meter list */}
        {address && filteredMeterIds.length > 0 && (
          <div className="space-y-4">
            {visibleGroups.map(({ group, members }) => (
              <GroupCard
                key={group.id}
                title={group.name}
                color={group.color}
                members={members}
                meters={meters}
                failedMeters={failedMeters}
                tags={tags}
                onAddTag={addTag}
                onRemoveTag={removeTag}
                onRemoveMeter={removeMeterFromGroup}
                collapsed={!!collapsedGroups[group.id]}
                onToggle={() => toggleCollapse(group.id)}
              />
            ))}

            {ungroupedIds.length > 0 && (
              <GroupCard
                title="Ungrouped"
                members={ungroupedIds}
                meters={meters}
                failedMeters={failedMeters}
                tags={tags}
                onAddTag={addTag}
                onRemoveTag={removeTag}
                onRemoveMeter={removeMeterFromGroup}
                collapsed={!!collapsedGroups.__ungrouped__}
                onToggle={() => toggleCollapse("__ungrouped__")}
              />
            )}

            {visibleGroups.length === 0 && ungroupedIds.length === 0 && (
              <p className="text-xs text-gray-500">
                {meterIds.length === 0
                  ? "No meters registered to this address."
                  : "No meters match the current filters."}
              </p>
            )}
          </div>
        )}
      </main>
    </ErrorBoundary>
  );
}
