"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { env } from "@/lib/env";
import { useFormatters } from "@/components/I18nProvider";

const API = env.NEXT_PUBLIC_BACKEND_URL;

interface Recommendation {
  id: number;
  kind: string;
  message: string;
  priority: "high" | "medium" | "low";
  estimatedWeeklySavingKwh: number;
  estimatedWeeklySavingCost: number;
  status: "pending" | "accepted" | "dismissed";
  actualWeeklySavingKwh: number | null;
  actualWeeklySavingCost: number | null;
}

const PRIORITY_ORDER: Record<Recommendation["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const PRIORITY_STYLES: Record<Recommendation["priority"], string> = {
  high: "bg-red-500/20 text-red-300",
  medium: "bg-amber-500/20 text-amber-300",
  low: "bg-sky-500/20 text-sky-300",
};

interface Savings {
  acceptedCount: number;
  estimatedWeeklySavingKwh: number;
  actualWeeklySavingKwh: number;
  estimatedWeeklySavingCost: number;
  actualWeeklySavingCost: number;
}

type NudgeStrategy = "social_comparison" | "loss_aversion" | "default_option" | "commitment";

interface Nudge {
  id: number;
  strategy: NudgeStrategy;
  message: string;
  variant: string;
  actionLabel: string;
  impactKwh: number | null;
}

interface NudgeImpact {
  strategy: NudgeStrategy;
  variant: string;
  delivered: number;
  accepted: number;
  measuredImpactKwh: number;
}

const NUDGE_STYLES: Record<NudgeStrategy, string> = {
  social_comparison: "border-sky-500/40 bg-sky-500/10",
  loss_aversion: "border-amber-500/40 bg-amber-500/10",
  default_option: "border-emerald-500/40 bg-emerald-500/10",
  commitment: "border-violet-500/40 bg-violet-500/10",
};

/** Weekly personalised recommendations with accept/dismiss + savings tracking (#895). */
export default function Recommendations({ meterId, ownerAddress }: { meterId: string; ownerAddress?: string }) {
  const t = useTranslations("recommendations");
  const { formatNumber, formatCurrency } = useFormatters();
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [savings, setSavings] = useState<Savings | null>(null);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [nudgeImpact, setNudgeImpact] = useState<NudgeImpact[]>([]);
  const base = `${API}/api/recommendations/${encodeURIComponent(meterId)}`;
  const nudgeBase = `${API}/api/nudges/${encodeURIComponent(meterId)}`;

  const load = useCallback(async () => {
    const [r, s, n, i] = await Promise.all([
      fetch(base),
      fetch(`${base}/savings`),
      fetch(nudgeBase),
      fetch(`${nudgeBase}/impact`),
    ]);
    if (r.ok) setRecs((await r.json()).recommendations);
    if (s.ok) setSavings(await s.json());
    if (n.ok) setNudges((await n.json()).nudges);
    if (i.ok) setNudgeImpact((await i.json()).impact);
  }, [base, nudgeBase]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!ownerAddress) return;
    void fetch(`${base}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerAddress }),
    });
  }, [base, ownerAddress]);

  async function respond(id: number, action: "accept" | "dismiss") {
    const res = await fetch(`${base}/${id}/${action}`, { method: "POST" });
    if (res.ok) void load();
  }

  async function respondToNudge(id: number, action: "accept" | "dismiss") {
    const res = await fetch(`${nudgeBase}/${id}/${action}`, { method: "POST" });
    if (res.ok) void load();
  }

  const pending = recs
    .filter((r) => r.status === "pending")
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  return (
    <section className="space-y-3 rounded-xl bg-white/5 p-4" aria-labelledby="recs-title">
      <h2 id="recs-title" className="text-lg font-semibold">{t("title")}</h2>
      {nudges.length > 0 && (
        <ul className="space-y-2" aria-label={t("nudges.title")}>
          {nudges.map((n) => (
            <li key={n.id} className={`rounded-lg border p-3 ${NUDGE_STYLES[n.strategy]}`}>
              <div className="flex items-start justify-between gap-2">
                <p>{n.message}</p>
                <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium">
                  {t(`nudges.strategy.${n.strategy}`)}
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => respondToNudge(n.id, "accept")}
                  className="rounded bg-green-600 px-3 py-1 text-sm"
                >
                  {n.actionLabel}
                </button>
                <button
                  onClick={() => respondToNudge(n.id, "dismiss")}
                  className="rounded bg-white/10 px-3 py-1 text-sm"
                >
                  {t("dismiss")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pending.length === 0 ? (
        <p className="opacity-70">{t("none")}</p>
      ) : (
        <ul className="space-y-2">
          {pending.map((r) => (
            <li key={r.id} className="rounded-lg border border-white/10 p-3">
              <div className="flex items-start justify-between gap-2">
                <p>{r.message}</p>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[r.priority]}`}
                >
                  {t(`priority.${r.priority}`)}
                </span>
              </div>
              <p className="mt-1 text-sm opacity-70">
                {t("estimated", { kwh: formatNumber(r.estimatedWeeklySavingKwh) })}
              </p>
              <p className="text-sm font-medium text-green-400">
                {t("potentialSavings", {
                  kwh: formatNumber(r.estimatedWeeklySavingKwh),
                  cost: formatCurrency(r.estimatedWeeklySavingCost),
                })}
              </p>
              <div className="mt-2 flex gap-2">
                <button onClick={() => respond(r.id, "accept")} className="rounded bg-green-600 px-3 py-1 text-sm">
                  {t("accept")}
                </button>
                <button onClick={() => respond(r.id, "dismiss")} className="rounded bg-white/10 px-3 py-1 text-sm">
                  {t("dismiss")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {savings && savings.acceptedCount > 0 && (
        <div className="space-y-2">
          <div className="text-sm opacity-70">
            {t("adopted", { count: formatNumber(savings.acceptedCount) })}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="opacity-70">{t("estimatedSavings")}</div>
              <div className="font-semibold">
                {formatNumber(savings.estimatedWeeklySavingKwh)} kWh · {formatCurrency(savings.estimatedWeeklySavingCost)}
              </div>
            </div>
            <div>
              <div className="opacity-70">{t("actualSavings")}</div>
              <div className="font-semibold">
                {formatNumber(savings.actualWeeklySavingKwh)} kWh · {formatCurrency(savings.actualWeeklySavingCost)}
              </div>
            </div>
          </div>
        </div>
      )}
      {nudgeImpact.length > 0 && (
        <div className="space-y-1 text-sm">
          <div className="opacity-70">{t("nudges.impact")}</div>
          <ul className="space-y-1">
            {nudgeImpact.map((row) => (
              <li key={`${row.strategy}-${row.variant}`} className="flex justify-between gap-2">
                <span>
                  {t(`nudges.strategy.${row.strategy}`)} · {row.variant}
                </span>
                <span className="font-semibold">
                  {formatNumber(row.measuredImpactKwh)} kWh
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
