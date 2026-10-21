"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { env } from "@/lib/env";
import { useFormatters } from "@/components/I18nProvider";

const API = env.NEXT_PUBLIC_BACKEND_URL;

interface Facility {
  meterId: string;
  name: string;
  type: string;
  demandKwh: number;
  allocatedKwh: number;
}

interface Snapshot {
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
  poolKwh: number;
  totalDonatedKwh: number;
  donorCount: number;
  facilities: Facility[];
  recentDonations: Array<{ donorMeterId: string; kwh: number; at: string }>;
}

/** Emergency energy sharing dashboard (#893). */
export default function EmergencyPage() {
  const t = useTranslations("emergency");
  const { formatNumber, formatDateTime } = useFormatters();
  const [data, setData] = useState<Snapshot | null>(null);
  const [donor, setDonor] = useState("");
  const [kwh, setKwh] = useState("1");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/emergency`);
    if (res.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function donate(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(`${API}/api/emergency/donations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ donorMeterId: donor, kwh: Number(kwh) }),
    });
    setMessage(res.ok ? t("donateSuccess") : t("donateFailed"));
    if (res.ok) void load();
  }

  if (!data) return <main id="main-content" className="p-6">{t("loading")}</main>;

  return (
    <main id="main-content" className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${
            data.active ? "bg-red-600 text-white" : "bg-green-700 text-white"
          }`}
        >
          {data.active ? t("active") : t("inactive")}
        </span>
      </header>

      {data.active && (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          {data.reason} · {t("since")} {data.activatedAt && formatDateTime(data.activatedAt)}
        </p>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label={t("pool")} value={`${formatNumber(data.poolKwh)} kWh`} />
        <Stat label={t("donated")} value={`${formatNumber(data.totalDonatedKwh)} kWh`} />
        <Stat label={t("donors")} value={formatNumber(data.donorCount)} />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t("facilities")}</h2>
        {data.facilities.length === 0 ? (
          <p className="opacity-70">{t("noFacilities")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr>
                  <th className="text-start">{t("facility")}</th>
                  <th className="text-start">{t("type")}</th>
                  <th className="text-start">{t("coverage")}</th>
                </tr>
              </thead>
              <tbody>
                {data.facilities.map((f) => (
                  <tr key={f.meterId}>
                    <td>{f.name}</td>
                    <td>{t(`types.${f.type}`)}</td>
                    <td>
                      {formatNumber(f.allocatedKwh)} / {formatNumber(f.demandKwh)} kWh
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.active && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t("donateTitle")}</h2>
          <form onSubmit={donate} className="flex flex-wrap gap-2">
            <input
              aria-label={t("meterId")}
              placeholder={t("meterId")}
              value={donor}
              onChange={(e) => setDonor(e.target.value)}
              className="rounded border px-2 py-1 text-black"
              required
            />
            <input
              aria-label="kWh"
              type="number"
              min="0.1"
              max="1000"
              step="0.1"
              value={kwh}
              onChange={(e) => setKwh(e.target.value)}
              className="w-28 rounded border px-2 py-1 text-black"
            />
            <button type="submit" className="rounded bg-yellow-500 px-4 py-1 font-semibold text-black">
              {t("donate")}
            </button>
          </form>
          {message && <p role="status" className="mt-2">{message}</p>}
        </section>
      )}

      {data.recentDonations.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t("recentDonations")}</h2>
          <ul className="space-y-1 text-sm">
            {data.recentDonations.map((d, i) => (
              <li key={i}>
                {d.donorMeterId} · {formatNumber(d.kwh)} kWh · {formatDateTime(d.at)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/5 p-4">
      <div className="text-sm opacity-70">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}
