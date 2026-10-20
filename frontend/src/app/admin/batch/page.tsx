"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import { useToast } from "@/components/ToastProvider";

const API = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";
const MAX_BATCH_ACTIONS = 25;

type ActionType = "SetActive" | "SetDailyLimit" | "AllowlistAdd" | "AllowlistRemove" | "SetOracle";
type Action =
  | { type: "SetActive"; meterId: string; active: boolean }
  | { type: "SetDailyLimit"; meterId: string; limit: string }
  | { type: "AllowlistAdd" | "AllowlistRemove" | "SetOracle"; address: string };

const needsMeter = (t: ActionType) => t === "SetActive" || t === "SetDailyLimit";

export default function BatchBuilderPage() {
  const { showToast } = useToast();
  const [actions, setActions] = useState<Action[]>([]);
  const [type, setType] = useState<ActionType>("AllowlistAdd");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function add() {
    if (!target) return showToast({ title: "Target is required", variant: "error" });
    if (actions.length >= MAX_BATCH_ACTIONS) return showToast({ title: `Max ${MAX_BATCH_ACTIONS} actions`, variant: "error" });
    const a: Action =
      type === "SetActive"
        ? { type, meterId: target, active: value !== "false" }
        : type === "SetDailyLimit"
          ? { type, meterId: target, limit: value || "0" }
          : { type, address: target };
    setActions([...actions, a]);
    setTarget("");
    setValue("");
  }

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      showToast({ title: `Batch of ${body.count} executed: ${body.hash.slice(0, 10)}…`, variant: "success" });
      setActions([]);
    } catch (err) {
      showToast({ title: (err as Error).message || "Batch failed", variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen">
      <Navbar />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <h1 className="text-2xl font-bold text-solar-yellow">Admin Batch Builder</h1>
        <p className="text-sm text-white/60">
          All actions execute atomically in one transaction and need a single multi-sig approval.
        </p>
        <div className="flex flex-wrap gap-2">
          <select className="px-3 py-2 rounded bg-white/5" value={type}
            onChange={(e) => setType(e.target.value as ActionType)}>
            {(["AllowlistAdd", "AllowlistRemove", "SetOracle", "SetActive", "SetDailyLimit"] as const).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input className="px-3 py-2 rounded bg-white/5 flex-1 min-w-0"
            placeholder={needsMeter(type) ? "Meter ID" : "G… address"} value={target}
            onChange={(e) => setTarget(e.target.value)} />
          {needsMeter(type) && (
            <input className="px-3 py-2 rounded bg-white/5 w-32"
              placeholder={type === "SetActive" ? "true/false" : "Limit (stroops)"} value={value}
              onChange={(e) => setValue(e.target.value)} />
          )}
          <button className="px-4 py-2 rounded bg-white/10" onClick={add}>Add</button>
        </div>
        <ol className="space-y-2 list-decimal list-inside">
          {actions.map((a, i) => (
            <li key={i} className="flex justify-between gap-2 border border-white/10 rounded p-2 font-mono text-sm">
              <span className="truncate">{JSON.stringify(a)}</span>
              <button onClick={() => setActions(actions.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ol>
        <button disabled={!actions.length || submitting} onClick={submit}
          className="px-4 py-2 rounded bg-solar-yellow text-black disabled:opacity-50">
          {submitting ? "Submitting…" : `Execute batch (${actions.length})`}
        </button>
      </div>
    </main>
  );
}
