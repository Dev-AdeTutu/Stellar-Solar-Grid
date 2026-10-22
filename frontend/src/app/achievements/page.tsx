"use client";

/**
 * Energy consumption gamification (#996): achievement badges and the
 * green-energy / trading leaderboards, with optional region filtering.
 */
import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type Achievement = { id: string; name: string; description: string; unlockedAt?: string | null };
type Entry = { rank: number; address: string; displayName: string; score: number };
type Board = "green" | "trader";

function AchievementBadge({ achievement }: { achievement: Achievement }) {
  const unlocked = Boolean(achievement.unlockedAt);
  return (
    <li
      className={`rounded border p-3 text-sm ${unlocked ? "border-amber-500 bg-amber-500/10" : "border-white/10 opacity-50"}`}
      title={achievement.description}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>{unlocked ? "🏆" : "🔒"}</span>
        <span className="font-medium">{achievement.name}</span>
      </div>
      <p className="mt-1 text-xs opacity-70">{achievement.description}</p>
    </li>
  );
}

export default function AchievementsPage() {
  const { address, connect } = useWalletStore();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [board, setBoard] = useState<Board>("green");
  const [region, setRegion] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = address ? `${API}/api/achievements?address=${address}` : `${API}/api/achievements`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setAchievements(d.achievements))
      .catch((e: Error) => setError(e.message));
  }, [address]);

  useEffect(() => {
    const params = new URLSearchParams({ board, limit: "20" });
    if (region.trim()) params.set("region", region.trim());
    fetch(`${API}/api/leaderboards?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setEntries(d.entries ?? []))
      .catch((e: Error) => setError(e.message));
  }, [board, region]);

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Achievements &amp; Leaderboards</h1>
        <p className="text-sm opacity-70 mb-4">
          Badges for saving energy and trading, plus the global and regional leaderboards.
        </p>
        {error && <p className="text-red-500">{error}</p>}

        {!address && (
          <button className="mb-6 rounded bg-sky-600 px-3 py-1.5 text-sm text-white" onClick={() => connect()}>
            Connect wallet to see your progress
          </button>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <section>
            <h2 className="text-lg font-semibold mb-2">Achievements</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {achievements.map((a) => (
                <AchievementBadge key={a.id} achievement={a} />
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">Leaderboard</h2>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div role="tablist" className="flex gap-2">
                {(["green", "trader"] as const).map((b) => (
                  <button
                    key={b}
                    role="tab"
                    aria-selected={board === b}
                    className={`rounded px-3 py-1.5 text-sm capitalize ${board === b ? "bg-sky-600 text-white" : "border"}`}
                    onClick={() => setBoard(b)}
                  >
                    {b === "green" ? "Top savers" : "Top traders"}
                  </button>
                ))}
              </div>
              {board === "green" && (
                <input
                  aria-label="Filter by region"
                  className="rounded border px-2 py-1 text-sm bg-transparent"
                  placeholder="Region (e.g. NG) — optional"
                  maxLength={32}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              )}
            </div>
            {entries.length === 0 ? (
              <p className="text-sm opacity-70">No scores yet.</p>
            ) : (
              <ol className="divide-y divide-white/10">
                {entries.map((e) => (
                  <li key={e.address} className="flex items-center justify-between py-2 text-sm">
                    <span className="flex items-center gap-3">
                      <span className="w-6 text-right font-semibold">{e.rank}</span>
                      <span>{e.displayName}</span>
                    </span>
                    <span className="font-mono">{e.score.toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
