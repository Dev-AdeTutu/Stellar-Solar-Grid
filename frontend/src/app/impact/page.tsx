'use client';

import { useEffect, useState } from 'react';

/** Social impact dashboard (#1054). See docs/IMPACT.md. */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

interface Report {
  totals: {
    householdsElectrified: number;
    jobsCreated: number;
    annualIncomeGainUsd: number;
    avgIncomeImprovementPct: number;
    co2AvoidedTonnes: number;
  };
  sdgs: { sdg: number; name: string; indicators: Record<string, number> }[];
  sroi: { socialValueUsd: number; investmentUsd: number; ratio: number };
  stories: { id: string; author: string; quote: string }[];
}

export default function ImpactPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/impact/report`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setReport)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <main className="p-6 text-red-600">{error}</main>;
  if (!report) return <main className="p-6">Loading…</main>;
  const t = report.totals;

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Social Impact</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Households electrified" value={t.householdsElectrified.toLocaleString()} />
        <Stat label="Jobs created" value={t.jobsCreated.toLocaleString()} />
        <Stat label="Annual income gain" value={`$${t.annualIncomeGainUsd.toLocaleString()}`} />
        <Stat label="Avg income improvement" value={`${t.avgIncomeImprovementPct}%`} />
        <Stat label="CO₂ avoided" value={`${t.co2AvoidedTonnes} t`} />
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-2">UN SDG alignment</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {report.sdgs.map((s) => (
            <div key={s.sdg} className="rounded border p-3">
              <div className="font-semibold">SDG {s.sdg}: {s.name}</div>
              <ul className="text-sm">
                {Object.entries(s.indicators).map(([k, v]) => (
                  <li key={k}>{k}: {v.toLocaleString()}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Social return on investment</h2>
        <p>
          <strong>{report.sroi.ratio}×</strong> — ${report.sroi.socialValueUsd.toLocaleString()} annual social value on $
          {report.sroi.investmentUsd.toLocaleString()} invested
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Stories</h2>
        {report.stories.length === 0 && <p>No stories yet.</p>}
        {report.stories.map((s) => (
          <blockquote key={s.id} className="border-l-4 pl-3 italic">
            “{s.quote}” — {s.author}
          </blockquote>
        ))}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
