"use client";

/**
 * Energy competitions (#903): browse monthly competitions, join with a meter,
 * and watch the leaderboard update live (Server-Sent Events).
 */
import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { usePaymentStore } from "@/store/paymentStore";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const STROOPS_PER_XLM = 10_000_000;

type CompetitionType = "efficiency" | "trading" | "green_energy";
type Competition = {
  id: string;
  name: string;
  type: CompetitionType;
  status: "scheduled" | "active" | "completed" | "cancelled";
  starts_at: string;
  ends_at: string;
  rules: { prizes: number[]; minParticipants: number; maxParticipants: number | null };
};
type Entry = { rank: number; meterId: string; displayName: string | null; score: number; detail: Record<string, number> };
type Prize = { rank: number; meter_id: string; amount: number; status: string; tx_hash: string | null };

const TYPE_INFO: Record<CompetitionType, { label: string; scoreLabel: string; unit: string; blurb: string }> = {
  efficiency: {
    label: "Efficiency",
    scoreLabel: "Reduction",
    unit: "%",
    blurb: "Cut your average daily consumption the most compared with the previous period.",
  },
  trading: { label: "Trading", scoreLabel: "Traded", unit: " units", blurb: "Trade the most energy on the marketplace." },
  green_energy: { label: "Green energy", scoreLabel: "Renewable", unit: " units", blurb: "Use the most renewable energy." },
};

const xlm = (stroops: number) => `${(stroops / STROOPS_PER_XLM).toLocaleString()} XLM`;

function timeLeft(end: string) {
  const ms = new Date(end).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return d > 0 ? `${d}d ${h}h left` : `${h}h left`;
}

function Leaderboard({ competition }: { competition: Competition }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [prizes, setPrizes] = useState<Prize[]>([]);
  const [live, setLive] = useState(false);
  const info = TYPE_INFO[competition.type];

  useEffect(() => {
    const source = new EventSource(`${API}/api/competitions/${competition.id}/leaderboard/stream`);
    source.addEventListener("leaderboard", (e) => {
      setEntries(JSON.parse((e as MessageEvent).data).entries);
      setLive(true);
    });
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [competition.id]);

  useEffect(() => {
    if (competition.status !== "completed") return;
    fetch(`${API}/api/competitions/${competition.id}`)
      .then((r) => r.json())
      .then((d) => setPrizes(d.prizes ?? []))
      .catch(() => {});
  }, [competition.id, competition.status]);

  return (
    <div>
      <div className="flex items-center gap-2 text-xs opacity-70 mb-2">
        <span className={`inline-block w-2 h-2 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} aria-hidden />
        {live ? "Live" : "Connecting…"}
      </div>
      {entries.length === 0 ? (
        <p className="text-sm opacity-70">No scores yet.</p>
      ) : (
        <ol className="divide-y divide-white/10">
          {entries.slice(0, 20).map((e) => {
            const prize = competition.rules.prizes[e.rank - 1];
            const paid = prizes.find((p) => p.rank === e.rank);
            return (
              <li key={e.meterId} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-3">
                  <span className="w-6 text-right font-semibold">{e.rank}</span>
                  <span>{e.displayName ?? e.meterId}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-mono">
                    {e.score}
                    {info.unit}
                  </span>
                  {prize ? (
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
                      {xlm(prize)}
                      {paid?.status === "paid" ? " ✓" : ""}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function JoinForm({ competition, onJoined }: { competition: Competition; onJoined: () => void }) {
  const { address, connect } = useWalletStore();
  const storedMeter = usePaymentStore((s) => s.meterId);
  const [meterId, setMeterId] = useState(storedMeter);
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  if (!address) {
    return (
      <button className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white" onClick={() => connect()}>
        Connect wallet to join
      </button>
    );
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const res = await fetch(`${API}/api/competitions/${competition.id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meterId: meterId.trim(), stellarAddress: address, displayName: displayName.trim() || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setMessage("You're in! Prizes are paid to your connected wallet.");
      onJoined();
    } else setMessage(body.error ?? `Failed (${res.status})`);
  }

  return (
    <form onSubmit={join} className="flex flex-wrap gap-2 items-center">
      <input
        aria-label="Meter ID"
        className="rounded border px-2 py-1 text-sm bg-transparent"
        placeholder="Meter ID"
        value={meterId}
        onChange={(e) => setMeterId(e.target.value)}
        required
      />
      <input
        aria-label="Display name (optional)"
        className="rounded border px-2 py-1 text-sm bg-transparent"
        placeholder="Display name (optional)"
        maxLength={40}
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <button type="submit" className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white">
        Join
      </button>
      {message && <p className="w-full text-sm opacity-80">{message}</p>}
    </form>
  );
}

export default function CompetitionsPage() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "completed">("active");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const statuses = tab === "active" ? ["active", "scheduled"] : ["completed"];
    Promise.all(
      statuses.map((s) =>
        fetch(`${API}/api/competitions?status=${s}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      ),
    )
      .then((results) => {
        const list = results.flatMap((r) => r.competitions as Competition[]);
        setCompetitions(list);
        setSelected((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  }, [tab, reload]);

  const current = competitions.find((c) => c.id === selected);

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Competitions</h1>
        <p className="text-sm opacity-70 mb-4">Monthly challenges with XLM prizes paid automatically to the winners.</p>

        <div role="tablist" className="flex gap-2 mb-6">
          {(["active", "completed"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`rounded px-3 py-1.5 text-sm capitalize ${tab === t ? "bg-sky-600 text-white" : "border"}`}
              onClick={() => setTab(t)}
            >
              {t === "active" ? "Current & upcoming" : "Past"}
            </button>
          ))}
        </div>

        {error && <p className="text-red-500">Failed to load competitions: {error}</p>}
        {!error && competitions.length === 0 && <p className="opacity-70">No competitions here yet.</p>}

        <div className="grid gap-6 md:grid-cols-[1fr_2fr]">
          <ul className="space-y-2">
            {competitions.map((c) => (
              <li key={c.id}>
                <button
                  className={`w-full rounded border p-3 text-left ${c.id === selected ? "border-sky-500" : "border-white/10"}`}
                  onClick={() => setSelected(c.id)}
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs opacity-70">
                    {TYPE_INFO[c.type].label} · {c.status === "active" ? timeLeft(c.ends_at) : c.status}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {current && (
            <section className="rounded border border-white/10 p-4">
              <h2 className="text-xl font-semibold">{current.name}</h2>
              <p className="text-sm opacity-70 mb-2">{TYPE_INFO[current.type].blurb}</p>
              <p className="text-xs opacity-70 mb-4">
                {new Date(current.starts_at).toLocaleDateString()} – {new Date(current.ends_at).toLocaleDateString()} · Prizes:{" "}
                {current.rules.prizes.map((p, i) => `#${i + 1} ${xlm(p)}`).join(", ") || "none"} · Min{" "}
                {current.rules.minParticipants} participants
              </p>
              {(current.status === "active" || current.status === "scheduled") && (
                <div className="mb-4">
                  <JoinForm competition={current} onJoined={() => setReload((n) => n + 1)} />
                </div>
              )}
              <Leaderboard key={current.id} competition={current} />
            </section>
          )}
        </div>
      </main>
    </>
  );
}
