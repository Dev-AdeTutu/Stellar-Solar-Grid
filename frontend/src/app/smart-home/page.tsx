"use client";

/**
 * Smart home settings (#904): linked voice assistants, energy routines,
 * voice-activity history and data deletion.
 */
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { usePaymentStore } from "@/store/paymentStore";
import { clearSmartHomeSession, getSmartHomeSession, smartHomeFetch } from "@/lib/smartHomeClient";

type Link = { id: string; platform: "google" | "alexa"; meters: { meterId: string; nickname: string | null }[]; scopes: string[]; created_at: string; last_used_at: string | null };
type Trigger =
  | { type: "schedule"; time: string; days: number[]; timezone: string }
  | { type: "balance_below"; meterId: string; threshold: number }
  | { type: "voice" };
type Routine = { id: string; name: string; enabled: boolean; trigger: Trigger; actions: { meterId: string; command: "on" | "off" }[]; last_run_at: string | null };
type Activity = { id: number; platform: string; action: string; meter_id: string | null; result: string; created_at: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STROOPS_PER_XLM = 10_000_000;

function describeTrigger(t: Trigger) {
  if (t.type === "schedule") {
    const days = t.days.length === 7 ? "every day" : t.days.map((d) => DAYS[d]).join(", ");
    return `At ${t.time} ${days} (${t.timezone})`;
  }
  if (t.type === "balance_below") return `When ${t.meterId} balance drops below ${t.threshold / STROOPS_PER_XLM} XLM`;
  return "Voice only";
}

function RoutineForm({ onCreate }: { onCreate: (body: unknown) => Promise<void> }) {
  const storedMeter = usePaymentStore((s) => s.meterId);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<Trigger["type"]>("schedule");
  const [time, setTime] = useState("22:00");
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [thresholdXlm, setThresholdXlm] = useState("5");
  const [meterId, setMeterId] = useState(storedMeter);
  const [command, setCommand] = useState<"on" | "off">("off");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const trigger =
      triggerType === "schedule"
        ? { type: "schedule", time, days, timezone }
        : triggerType === "balance_below"
          ? { type: "balance_below", meterId, threshold: Math.round(Number(thresholdXlm) * STROOPS_PER_XLM) }
          : { type: "voice" };
    try {
      await onCreate({ name, trigger, actions: [{ meterId, command }] });
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={submit} className="rounded border border-white/10 p-4 space-y-3">
      <h3 className="font-semibold">New routine</h3>
      <input className="w-full rounded border px-2 py-1 bg-transparent" placeholder="Name, e.g. Night Saver" aria-label="Routine name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-sm">
          Turn{" "}
          <select className="rounded border bg-transparent px-1" value={command} onChange={(e) => setCommand(e.target.value as "on" | "off")}>
            <option value="off">off</option>
            <option value="on">on</option>
          </select>
        </label>
        <input className="rounded border px-2 py-1 bg-transparent" placeholder="Meter ID" aria-label="Meter ID" value={meterId} onChange={(e) => setMeterId(e.target.value)} required />
      </div>
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <span>Trigger:</span>
        <select className="rounded border bg-transparent px-1" value={triggerType} onChange={(e) => setTriggerType(e.target.value as Trigger["type"])} aria-label="Trigger type">
          <option value="schedule">On a schedule</option>
          <option value="balance_below">When balance is low</option>
          <option value="voice">Only when I ask</option>
        </select>
        {triggerType === "schedule" && (
          <>
            <input type="time" className="rounded border bg-transparent px-1" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" required />
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1">
                <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays((all) => (e.target.checked ? [...all, i] : all.filter((x) => x !== i)))} />
                {d}
              </label>
            ))}
          </>
        )}
        {triggerType === "balance_below" && (
          <label className="flex items-center gap-1">
            below
            <input type="number" min="0" step="0.1" className="w-20 rounded border bg-transparent px-1" value={thresholdXlm} onChange={(e) => setThresholdXlm(e.target.value)} />
            XLM
          </label>
        )}
      </div>
      <p className="text-xs opacity-70">Every routine can also be started by voice: &ldquo;Hey Google, activate {name || "Night Saver"}&rdquo;.</p>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <button type="submit" className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={triggerType === "schedule" && days.length === 0}>
        Create routine
      </button>
    </form>
  );
}

export default function SmartHomePage() {
  const { address, connect, signTransaction } = useWalletStore();
  const [token, setToken] = useState<string | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (t: string) => {
    try {
      const [l, r, a] = await Promise.all([
        smartHomeFetch<{ links: Link[] }>(t, "/links"),
        smartHomeFetch<{ routines: Routine[] }>(t, "/routines"),
        smartHomeFetch<{ activity: Activity[] }>(t, "/activity?limit=50"),
      ]);
      setLinks(l.links);
      setRoutines(r.routines);
      setActivity(a.activity);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setToken(null);
    }
  }, []);

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  async function signIn() {
    if (!address) return;
    setError(null);
    try {
      setToken(await getSmartHomeSession(address, signTransaction));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function act(fn: () => Promise<unknown>, message?: string) {
    setError(null);
    try {
      await fn();
      if (message) setNotice(message);
      if (token) await load(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-4xl mx-auto space-y-8">
        <header>
          <h1 className="text-2xl font-bold mb-1">Smart Home</h1>
          <p className="text-sm opacity-70">
            Control your meters with Google Home or Alexa and automate them with energy routines. To connect, open the Google Home or
            Alexa app and add &ldquo;SolarGrid&rdquo;.
          </p>
        </header>

        {!address ? (
          <button className="rounded bg-sky-600 px-4 py-2 text-white" onClick={() => connect()}>
            Connect wallet
          </button>
        ) : !token ? (
          <button className="rounded bg-sky-600 px-4 py-2 text-white" onClick={signIn}>
            Sign in with wallet
          </button>
        ) : null}

        {error && <p className="text-red-500">{error}</p>}
        {notice && <p className="text-green-500">{notice}</p>}

        {token && (
          <>
            <section>
              <h2 className="text-lg font-semibold mb-2">Linked assistants</h2>
              {links.length === 0 ? (
                <p className="text-sm opacity-70">No assistants linked yet.</p>
              ) : (
                <ul className="space-y-2">
                  {links.map((l) => (
                    <li key={l.id} className="flex items-center justify-between rounded border border-white/10 p-3">
                      <div>
                        <div className="font-medium">{l.platform === "google" ? "Google Home" : "Amazon Alexa"}</div>
                        <div className="text-xs opacity-70">
                          {l.meters.map((m) => m.nickname ?? m.meterId).join(", ")} · {l.scopes.includes("control") ? "can control" : "read only"} · last used{" "}
                          {l.last_used_at ? new Date(l.last_used_at).toLocaleString() : "never"}
                        </div>
                      </div>
                      <button className="text-sm text-red-500 underline" onClick={() => act(() => smartHomeFetch(token, `/links/${l.id}`, { method: "DELETE" }), "Assistant unlinked.")}>
                        Unlink
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Energy routines</h2>
              {routines.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/10 p-3">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs opacity-70">
                      {describeTrigger(r.trigger)} → {r.actions.map((a) => `turn ${a.command} ${a.meterId}`).join(", ")}
                      {r.last_run_at ? ` · last ran ${new Date(r.last_run_at).toLocaleString()}` : ""}
                    </div>
                  </div>
                  <div className="flex gap-3 text-sm">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => act(() => smartHomeFetch(token, `/routines/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) }))}
                      />
                      Enabled
                    </label>
                    <button className="underline" onClick={() => act(() => smartHomeFetch(token, `/routines/${r.id}/run`, { method: "POST" }), `Ran ${r.name}.`)}>
                      Run now
                    </button>
                    <button className="text-red-500 underline" onClick={() => act(() => smartHomeFetch(token, `/routines/${r.id}`, { method: "DELETE" }))}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              <RoutineForm onCreate={(body) => act(() => smartHomeFetch(token, "/routines", { method: "POST", body: JSON.stringify(body) }), "Routine created.")} />
            </section>

            <section>
              <h2 className="text-lg font-semibold mb-2">Recent activity</h2>
              <p className="text-xs opacity-70 mb-2">Voice and routine activity is kept for 30 days.</p>
              {activity.length === 0 ? (
                <p className="text-sm opacity-70">No activity yet.</p>
              ) : (
                <ul className="text-sm divide-y divide-white/10">
                  {activity.map((a) => (
                    <li key={a.id} className="py-1.5 flex justify-between gap-4">
                      <span>
                        {a.platform} · {a.action.replace(/_/g, " ")}
                        {a.meter_id ? ` · ${a.meter_id}` : ""}
                      </span>
                      <span className="opacity-70 whitespace-nowrap">
                        {a.result} · {new Date(a.created_at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded border border-red-500/40 p-4">
              <h2 className="text-lg font-semibold mb-1">Delete my smart home data</h2>
              <p className="text-sm opacity-70 mb-3">Unlinks every assistant and deletes all routines and activity history. This cannot be undone.</p>
              {confirmErase ? (
                <div className="flex gap-3">
                  <button
                    className="rounded bg-red-600 px-3 py-1.5 text-sm text-white"
                    onClick={() =>
                      act(async () => {
                        await smartHomeFetch(token, "/data", { method: "DELETE" });
                        setConfirmErase(false);
                      }, "All smart home data deleted.")
                    }
                  >
                    Yes, delete everything
                  </button>
                  <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setConfirmErase(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="rounded border border-red-500 px-3 py-1.5 text-sm text-red-500" onClick={() => setConfirmErase(true)}>
                  Delete data…
                </button>
              )}
            </section>

            <button
              className="text-sm underline opacity-70"
              onClick={() => {
                clearSmartHomeSession();
                setToken(null);
              }}
            >
              Sign out of smart home settings
            </button>
          </>
        )}
      </main>
    </>
  );
}
