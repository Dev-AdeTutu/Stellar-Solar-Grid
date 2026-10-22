"use client";

import React, { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Challenge {
  id: string;
  name: string;
  metric: "peak_reduction" | "total_reduction";
  targetPct: number;
  endsAt: number;
  prizes: number[];
  status: string;
}

interface LeaderboardEntry {
  rank: number;
  meterId: string;
  reductionPct: number;
  targetMet: boolean;
}

interface Progress {
  reductionPct: number | null;
  targetPct: number;
  progressPct: number;
  rank: number | null;
}

/** Gamified energy challenges board (#1059): active challenges, leaderboards and personal progress. */
export default function ChallengeBoard({ meterId }: { meterId?: string }) {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/api/challenges`)
      .then((r) => r.json())
      .then((d) => {
        setChallenges(d.challenges ?? []);
        if (d.challenges?.length) setSelected(d.challenges[0].id);
      })
      .catch(() => setError("Could not load challenges"));
  }, []);

  const load = useCallback(async (id: string) => {
    const lb = await fetch(`${API}/api/challenges/${id}/leaderboard`).then((r) => r.json());
    setBoard(lb.leaderboard ?? []);
    if (meterId) {
      const r = await fetch(`${API}/api/challenges/${id}/progress/${encodeURIComponent(meterId)}`);
      setProgress(r.ok ? await r.json() : null);
    }
  }, [meterId]);

  useEffect(() => {
    if (selected) load(selected).catch(() => setError("Could not load leaderboard"));
  }, [selected, load]);

  const current = challenges.find((c) => c.id === selected);

  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900 p-4 text-slate-100">
      <h2 className="mb-3 text-lg font-semibold">Energy Challenges</h2>
      {error && <p className="text-red-400">{error}</p>}
      {challenges.length === 0 && !error && <p className="text-slate-400">No challenges right now.</p>}

      <div className="mb-4 flex flex-wrap gap-2">
        {challenges.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelected(c.id)}
            className={`rounded-full border px-3 py-1 text-sm ${
              c.id === selected ? "border-amber-400 bg-amber-400/20" : "border-slate-600"
            }`}
          >
            {c.name} <span className="text-xs text-slate-400">({c.status})</span>
          </button>
        ))}
      </div>

      {current && (
        <div className="mb-4 text-sm text-slate-300">
          Goal: reduce {current.metric === "peak_reduction" ? "peak" : "total"} usage by {current.targetPct}% · Ends{" "}
          {new Date(current.endsAt).toLocaleDateString()} · Prizes: {current.prizes.map((p) => `${p} XLM`).join(" / ")}
        </div>
      )}

      {progress && (
        <div className="mb-4">
          <div className="mb-1 text-sm">
            Your progress: {progress.reductionPct ?? 0}% of {progress.targetPct}%
            {progress.rank && ` · Rank #${progress.rank}`}
          </div>
          <div className="h-2 w-full rounded bg-slate-700" role="progressbar" aria-valuenow={progress.progressPct}>
            <div className="h-2 rounded bg-emerald-500" style={{ width: `${progress.progressPct}%` }} />
          </div>
        </div>
      )}

      {board.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400">
              <th>#</th>
              <th>Meter</th>
              <th>Reduction</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {board.map((e) => (
              <tr key={e.meterId} className={e.meterId === meterId ? "text-amber-300" : ""}>
                <td>{e.rank}</td>
                <td>{e.meterId}</td>
                <td>{e.reductionPct}%</td>
                <td>{e.targetMet ? "✅" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
