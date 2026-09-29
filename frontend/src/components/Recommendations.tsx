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
  estimatedWeeklySavingKwh: number;
  status: "pending" | "accepted" | "dismissed";
  actualWeeklySavingKwh: number | null;
}

interface Savings {
  acceptedCount: number;
  estimatedWeeklySavingKwh: number;
  actualWeeklySavingKwh: number;
  estimatedWeeklySavingCost: number;
  actualWeeklySavingCost: number;
}

/** Weekly personalised recommendations with accept/dismiss + savings tracking (#895). */
export default function Recommendations({ meterId, ownerAddress }: { meterId: string; ownerAddress?: string }) {
  const t = useTranslations("recommendations");
  const { formatNumber, formatCurrency } = useFormatters();
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [savings, setSavings] = useState<Savings | null>(null);
  const base = `${API}/api/recommendations/${encodeURIComponent(meterId)}`;

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([fetch(base), fetch(`${base}/savings`)]);
    if (r.ok) setRecs((await r.json()).recommendations);
    if (s.ok) setSavings(await s.json());
  }, [base]);

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

  const pending = recs.filter((r) => r.status === "pending");

  return (
    <section className="space-y-3 rounded-xl bg-white/5 p-4" aria-labelledby="recs-title">
      <h2 id="recs-title" className="text-lg font-semibold">{t("title")}</h2>
      {pending.length === 0 ? (
        <p className="opacity-70">{t("none")}</p>
      ) : (
        <ul className="space-y-2">
          {pending.map((r) => (
            <li key={r.id} className="rounded-lg border border-white/10 p-3">
              <p>{r.message}</p>
              <p className="mt-1 text-sm opacity-70">
                {t("estimated", { kwh: formatNumber(r.estimatedWeeklySavingKwh) })}
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
      )}
    </section>
  );
}
