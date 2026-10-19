"use client";

/**
 * Scheduled energy usage (#1001): a weekly on/off schedule per circuit, plus
 * an emergency override that forces a circuit on/off for a fixed window
 * regardless of its schedule.
 */
import { FormEvent, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import {
  setCircuitSchedule,
  getCircuitSchedule,
  overrideCircuit,
  clearCircuitOverride,
  circuitShouldBeOn,
  type Schedule,
} from "@/lib/contract";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INPUT = "rounded border border-white/20 bg-transparent px-3 py-2 text-sm";
const BTN = "rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40";

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function clockToMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return (h % 24) * 60 + (m % 60);
}

export default function SchedulesPage() {
  const { address } = useWalletStore();
  const { showToast } = useToast();

  const [meterId, setMeterId] = useState("");
  const [circuitId, setCircuitId] = useState("");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState("18:00");
  const [endTime, setEndTime] = useState("22:00");
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [loaded, setLoaded] = useState<Schedule | null>(null);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [currentlyOn, setCurrentlyOn] = useState<boolean | null>(null);

  const [overrideState, setOverrideState] = useState<"on" | "off">("on");
  const [overrideMinutes, setOverrideMinutes] = useState(60);
  const [overriding, setOverriding] = useState(false);

  const toggleDay = (d: number) => {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  };

  const daysToBitmask = (ds: number[]) => ds.reduce((mask, d) => mask | (1 << d), 0);
  const bitmaskToDays = (mask: number) => DAYS.map((_, d) => d).filter((d) => (mask >> d) & 1);

  const loadSchedule = async () => {
    if (!meterId.trim() || !circuitId.trim()) return;
    setLoadingSchedule(true);
    try {
      const schedule = await getCircuitSchedule(meterId.trim(), circuitId.trim());
      setLoaded(schedule);
      setDays(bitmaskToDays(schedule.days));
      setStartTime(minutesToClock(schedule.start_time));
      setEndTime(minutesToClock(schedule.end_time));
      setEnabled(schedule.enabled);
      const now = BigInt(Math.floor(Date.now() / 1000));
      setCurrentlyOn(await circuitShouldBeOn(meterId.trim(), circuitId.trim(), now));
    } catch (err) {
      setLoaded(null);
      setCurrentlyOn(null);
      showToast({ title: "No schedule found for this circuit yet", variant: "error" });
      console.warn(err);
    } finally {
      setLoadingSchedule(false);
    }
  };

  const submitSchedule = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!address) return;
    setSubmitting(true);
    try {
      const schedule: Schedule = {
        circuit_id: circuitId.trim(),
        days: daysToBitmask(days),
        start_time: clockToMinutes(startTime),
        end_time: clockToMinutes(endTime),
        enabled,
      };
      await setCircuitSchedule(address, meterId.trim(), schedule);
      showToast({ title: "Schedule saved" });
      await loadSchedule();
    } catch (err) {
      showToast({ title: "Failed to save schedule", description: (err as Error).message, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const submitOverride = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!address || !meterId.trim() || !circuitId.trim()) return;
    setOverriding(true);
    try {
      const until = BigInt(Math.floor(Date.now() / 1000) + overrideMinutes * 60);
      await overrideCircuit(address, meterId.trim(), circuitId.trim(), overrideState === "on", until);
      showToast({ title: `Circuit forced ${overrideState.toUpperCase()} for ${overrideMinutes} min` });
      await loadSchedule();
    } catch (err) {
      showToast({ title: "Override failed", description: (err as Error).message, variant: "error" });
    } finally {
      setOverriding(false);
    }
  };

  const endOverride = async () => {
    if (!address || !meterId.trim() || !circuitId.trim()) return;
    try {
      await clearCircuitOverride(address, meterId.trim(), circuitId.trim());
      showToast({ title: "Override cleared — schedule resumed" });
      await loadSchedule();
    } catch (err) {
      showToast({ title: "Failed to clear override", description: (err as Error).message, variant: "error" });
    }
  };

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-3xl mx-auto space-y-8">
        <h1 className="text-2xl font-bold">Scheduled Energy Usage</h1>
        {!address && <p className="opacity-80">Connect your wallet to manage schedules.</p>}

        <section className="rounded-lg border border-white/10 p-4 space-y-3">
          <h2 className="font-semibold">Circuit</h2>
          <div className="flex flex-wrap gap-2">
            <input
              className={`${INPUT} flex-1 min-w-[10rem]`}
              placeholder="Meter ID"
              aria-label="Meter ID"
              value={meterId}
              onChange={(e) => setMeterId(e.target.value)}
            />
            <input
              className={`${INPUT} flex-1 min-w-[10rem]`}
              placeholder="Circuit ID (device ID)"
              aria-label="Circuit ID"
              value={circuitId}
              onChange={(e) => setCircuitId(e.target.value)}
            />
            <button type="button" className={BTN} onClick={loadSchedule} disabled={loadingSchedule}>
              {loadingSchedule ? "Loading…" : "Load existing schedule"}
            </button>
          </div>
          {currentlyOn !== null && (
            <p className="text-sm opacity-80">
              Current evaluated state: <span className={currentlyOn ? "text-green-400" : "text-red-400"}>{currentlyOn ? "ON" : "OFF"}</span>
              {loaded && !loaded.enabled && " (schedule disabled)"}
            </p>
          )}
        </section>

        <form onSubmit={submitSchedule} className="rounded-lg border border-white/10 p-4 space-y-4">
          <h2 className="font-semibold">Weekly schedule</h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Days of week">
            {DAYS.map((label, d) => (
              <label key={label} className={`${INPUT} flex items-center gap-1 cursor-pointer`}>
                <input type="checkbox" checked={days.includes(d)} onChange={() => toggleDay(d)} />
                {label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm flex flex-col gap-1">
              Start time
              <input type="time" className={INPUT} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label className="text-sm flex flex-col gap-1">
              End time
              <input type="time" className={INPUT} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
          </div>
          <p className="text-xs opacity-60">
            If end time is earlier than start time the window spans midnight (e.g. 22:00 → 06:00). Times are UTC.
          </p>
          <button type="submit" className={BTN} disabled={!address || submitting || !meterId.trim() || !circuitId.trim()}>
            {submitting ? "Saving…" : "Save schedule"}
          </button>
        </form>

        <form onSubmit={submitOverride} className="rounded-lg border border-yellow-500/30 bg-yellow-900/10 p-4 space-y-3">
          <h2 className="font-semibold">Emergency override</h2>
          <p className="text-sm opacity-80">Force this circuit on or off for a fixed window, superseding its schedule.</p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm flex flex-col gap-1">
              Force
              <select className={INPUT} value={overrideState} onChange={(e) => setOverrideState(e.target.value as "on" | "off")}>
                <option value="on">ON</option>
                <option value="off">OFF</option>
              </select>
            </label>
            <label className="text-sm flex flex-col gap-1">
              For (minutes)
              <input
                type="number"
                min={1}
                className={`${INPUT} w-24`}
                value={overrideMinutes}
                onChange={(e) => setOverrideMinutes(Number(e.target.value))}
              />
            </label>
            <button type="submit" className={BTN} disabled={!address || overriding || !meterId.trim() || !circuitId.trim()}>
              {overriding ? "Applying…" : "Apply override"}
            </button>
            <button type="button" className={BTN} onClick={endOverride} disabled={!address || !meterId.trim() || !circuitId.trim()}>
              End override now
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
