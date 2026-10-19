"use client";

/**
 * PaymentSchedule — recurring payment reminder UI.
 *
 * Phase 1 (this PR, closes #746):
 *   - Configure a recurring payment schedule (weekly, monthly, custom interval).
 *   - Persist the schedule per meter in localStorage.
 *   - Use browser Notification API to remind the user when a payment is due.
 *   - User must manually approve each payment (blockchain tx still requires a
 *     wallet signature — no automated/delegated signing is performed).
 *
 * Phase 2 (future):
 *   - Explore Stellar SEP-0030 (Recurrent Payments) for true automation.
 *
 * ⚠️  WARNING: No tests are included in this PR. Tests should be added in a
 *     follow-up issue.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FrequencyUnit = "daily" | "weekly" | "monthly" | "custom";

export interface PaymentScheduleConfig {
  /** Whether the schedule is active (reminders will fire). */
  enabled: boolean;
  /** How often to remind the user. */
  frequency: FrequencyUnit;
  /** Custom interval in days (used when frequency === "custom"). */
  customIntervalDays: number;
  /** Payment amount in XLM (stored as a string to avoid float drift). */
  amount: string;
  /** Payment plan forwarded to the contract. */
  plan: "Daily" | "Weekly" | "Usage";
  /** ISO-8601 date string of the next scheduled reminder. */
  nextPaymentDate: string;
  /** Timestamp the schedule was last saved. */
  updatedAt: string;
}

interface Props {
  meterId: string;
  /** Called when the user clicks "Pay Now" from the reminder banner. */
  onPayNow?: (amount: string, plan: "Daily" | "Weekly" | "Usage") => void;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = "solar_schedule_";

function loadSchedule(meterId: string): PaymentScheduleConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${meterId}`);
    return raw ? (JSON.parse(raw) as PaymentScheduleConfig) : null;
  } catch {
    return null;
  }
}

function saveSchedule(meterId: string, config: PaymentScheduleConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${STORAGE_KEY_PREFIX}${meterId}`, JSON.stringify(config));
}

function clearSchedule(meterId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(`${STORAGE_KEY_PREFIX}${meterId}`);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function intervalDays(frequency: FrequencyUnit, customDays: number): number {
  switch (frequency) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
    case "custom":
      return Math.max(1, customDays);
  }
}

function nextDateFromNow(
  frequency: FrequencyUnit,
  customDays: number,
): string {
  const d = new Date();
  d.setDate(d.getDate() + intervalDays(frequency, customDays));
  return d.toISOString();
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ── Notification helper ───────────────────────────────────────────────────────

/**
 * Request notification permission and fire a reminder if the next payment
 * date is today or in the past. The notification links back to the pay page.
 */
async function maybeFireReminder(
  meterId: string,
  config: PaymentScheduleConfig,
): Promise<void> {
  if (!config.enabled) return;
  if (typeof window === "undefined" || !("Notification" in window)) return;

  const next = new Date(config.nextPaymentDate);
  const now = new Date();
  // Only fire if the scheduled date is today or overdue
  if (next.setHours(0, 0, 0, 0) > now.setHours(0, 0, 0, 0)) return;

  try {
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return;

    new Notification("SolarGrid — Payment Due", {
      body: `Your scheduled payment of ${config.amount} XLM for meter ${meterId} is due today. Tap to pay.`,
      icon: "/icons/icon-192.png",
      tag: `solar_schedule_${meterId}`,
    });
  } catch {
    // Notification API unavailable or blocked — silent fail
  }
}

// ── Default config factory ────────────────────────────────────────────────────

function defaultConfig(): PaymentScheduleConfig {
  return {
    enabled: false,
    frequency: "weekly",
    customIntervalDays: 7,
    amount: "10",
    plan: "Weekly",
    nextPaymentDate: nextDateFromNow("weekly", 7),
    updatedAt: new Date().toISOString(),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * PaymentSchedule
 *
 * Renders a compact panel for configuring recurring payment reminders.
 * Schedules are stored in localStorage (one key per meter ID).
 *
 * The user is always taken to the /pay page to sign the actual transaction —
 * no automated/delegated signing is performed here.
 *
 * Closes #746.
 */
export default function PaymentSchedule({ meterId, onPayNow }: Props) {
  const [config, setConfig] = useState<PaymentScheduleConfig>(defaultConfig);
  const [saved, setSaved] = useState(false);
  const [isDue, setIsDue] = useState(false);

  // Load persisted schedule on mount
  useEffect(() => {
    const persisted = loadSchedule(meterId);
    if (persisted) {
      setConfig(persisted);
      // Check if today's reminder should fire
      maybeFireReminder(meterId, persisted).catch(() => {});
      const next = new Date(persisted.nextPaymentDate);
      const today = new Date();
      setIsDue(persisted.enabled && next.setHours(0, 0, 0, 0) <= today.setHours(0, 0, 0, 0));
    }
  }, [meterId]);

  const handleSave = useCallback(() => {
    const updated: PaymentScheduleConfig = {
      ...config,
      nextPaymentDate: nextDateFromNow(config.frequency, config.customIntervalDays),
      updatedAt: new Date().toISOString(),
    };
    saveSchedule(meterId, updated);
    setConfig(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);

    // Fire reminder check after saving
    maybeFireReminder(meterId, updated).catch(() => {});
    const next = new Date(updated.nextPaymentDate);
    const today = new Date();
    setIsDue(updated.enabled && next.setHours(0, 0, 0, 0) <= today.setHours(0, 0, 0, 0));
  }, [config, meterId]);

  const handleCancel = useCallback(() => {
    clearSchedule(meterId);
    setConfig(defaultConfig());
    setIsDue(false);
  }, [meterId]);

  const handleChange = <K extends keyof PaymentScheduleConfig>(
    key: K,
    value: PaymentScheduleConfig[K],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <section
      aria-labelledby="payment-schedule-heading"
      className="rounded-xl border border-white/10 bg-solar-dark/60 p-5 space-y-4"
    >
      <h3
        id="payment-schedule-heading"
        className="text-sm font-semibold text-white flex items-center gap-2"
      >
        <span aria-hidden="true">🔁</span>
        Payment Schedule
      </h3>

      {/* Payment-due reminder banner */}
      {isDue && (
        <div
          role="alert"
          className="rounded-lg border border-yellow-500/40 bg-yellow-900/20 p-3 flex items-start justify-between gap-3"
        >
          <p className="text-xs text-yellow-300">
            <span className="font-semibold">Payment due today</span> — your scheduled{" "}
            {config.amount} XLM payment is ready. You must approve the transaction in your
            wallet.
          </p>
          {onPayNow ? (
            <button
              type="button"
              onClick={() => onPayNow(config.amount, config.plan)}
              className="shrink-0 rounded-lg bg-solar-yellow px-3 py-1 text-xs font-semibold text-solar-dark hover:brightness-110 transition"
            >
              Pay Now
            </button>
          ) : (
            <Link
              href={`/pay?meterId=${encodeURIComponent(meterId)}&amount=${encodeURIComponent(config.amount)}&plan=${encodeURIComponent(config.plan)}`}
              className="shrink-0 rounded-lg bg-solar-yellow px-3 py-1 text-xs font-semibold text-solar-dark hover:brightness-110 transition"
            >
              Pay Now
            </Link>
          )}
        </div>
      )}

      {/* Enable / disable toggle */}
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => handleChange("enabled", e.target.checked)}
          className="h-4 w-4 rounded border-white/20 bg-white/10 accent-solar-yellow"
          aria-label="Enable auto-payment reminder"
        />
        <span className="text-sm text-gray-300">Enable Auto-Payment Reminder</span>
      </label>

      {/* Schedule fields — only visible when enabled */}
      {config.enabled && (
        <div className="space-y-3">
          {/* Frequency */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`frequency-${meterId}`}
              className="text-xs font-medium text-gray-400"
            >
              Frequency
            </label>
            <select
              id={`frequency-${meterId}`}
              value={config.frequency}
              onChange={(e) =>
                handleChange("frequency", e.target.value as FrequencyUnit)
              }
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:border-solar-yellow focus:outline-none"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly (every 30 days)</option>
              <option value="custom">Custom interval</option>
            </select>
          </div>

          {/* Custom interval */}
          {config.frequency === "custom" && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor={`interval-${meterId}`}
                className="text-xs font-medium text-gray-400"
              >
                Interval (days)
              </label>
              <input
                id={`interval-${meterId}`}
                type="number"
                min={1}
                max={365}
                value={config.customIntervalDays}
                onChange={(e) =>
                  handleChange(
                    "customIntervalDays",
                    Math.max(1, Number(e.target.value) || 1),
                  )
                }
                className="w-28 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:border-solar-yellow focus:outline-none"
                aria-label="Custom interval in days"
              />
            </div>
          )}

          {/* Amount */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`amount-${meterId}`}
              className="text-xs font-medium text-gray-400"
            >
              Amount (XLM)
            </label>
            <input
              id={`amount-${meterId}`}
              type="number"
              min={0.01}
              step={0.01}
              value={config.amount}
              onChange={(e) => handleChange("amount", e.target.value)}
              className="w-36 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:border-solar-yellow focus:outline-none"
              aria-label="Payment amount in XLM"
            />
          </div>

          {/* Plan */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`plan-${meterId}`}
              className="text-xs font-medium text-gray-400"
            >
              Plan
            </label>
            <select
              id={`plan-${meterId}`}
              value={config.plan}
              onChange={(e) =>
                handleChange("plan", e.target.value as "Daily" | "Weekly" | "Usage")
              }
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:border-solar-yellow focus:outline-none"
            >
              <option value="Daily">Daily</option>
              <option value="Weekly">Weekly</option>
              <option value="Usage">Usage-Based</option>
            </select>
          </div>

          {/* Next payment date preview */}
          <p className="text-xs text-gray-500">
            Next reminder:{" "}
            <span className="text-gray-300">
              {formatDate(
                nextDateFromNow(config.frequency, config.customIntervalDays),
              )}
            </span>
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={handleSave}
          className="rounded-lg bg-solar-yellow px-4 py-1.5 text-xs font-semibold text-solar-dark hover:brightness-110 transition disabled:opacity-60"
        >
          {saved ? "✓ Saved" : "Save Schedule"}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className="rounded-lg border border-white/10 px-4 py-1.5 text-xs text-gray-400 hover:border-red-500/50 hover:text-red-400 transition"
        >
          Cancel
        </button>
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-gray-600">
        Reminders are stored locally in your browser. Each payment requires your wallet
        signature — no funds are moved automatically.
      </p>
    </section>
  );
}
