"use client";

/**
 * SMS notification preferences (#997) for users without a smartphone or
 * reliable data connection: opt in per event, by phone number.
 */
import { useState } from "react";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

const EVENTS: { key: "low_balance" | "payment_received" | "meter_issue"; label: string }[] = [
  { key: "low_balance", label: "Low balance alerts" },
  { key: "payment_received", label: "Payment received" },
  { key: "meter_issue", label: "Meter issue alerts" },
];

type Preferences = Record<(typeof EVENTS)[number]["key"], boolean>;

export default function SmsPreferencesPage() {
  const [phone, setPhone] = useState("");
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/users/sms-preferences?phone=${encodeURIComponent(phone.trim())}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPreferences(body.preferences);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }

  async function toggle(key: (typeof EVENTS)[number]["key"]) {
    if (!preferences) return;
    const next = { ...preferences, [key]: !preferences[key] };
    setPreferences(next);
    const res = await fetch(`${API}/api/users/sms-preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phone.trim(), preferences: { [key]: next[key] } }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(body.error ?? "Failed to save preference");
      setPreferences((p) => (p ? { ...p, [key]: !next[key] } : p)); // revert on failure
    } else {
      setPreferences(body.preferences);
      setStatus("Saved.");
    }
  }

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-md mx-auto">
        <h1 className="text-2xl font-bold mb-1">SMS Notifications</h1>
        <p className="text-sm opacity-70 mb-4">
          No smartphone or data plan? Get a text for low balance, payments and meter issues instead. SMS is off by
          default for every event until you opt in below.
        </p>

        <form onSubmit={load} className="flex gap-2 mb-6">
          <input
            aria-label="Phone number"
            className="flex-1 rounded border px-2 py-1.5 text-sm bg-transparent"
            placeholder="+2348012345678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <button type="submit" disabled={loading} className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {loading ? "Loading…" : "Load"}
          </button>
        </form>

        {status && <p className="mb-4 text-sm opacity-80">{status}</p>}

        {preferences && (
          <ul className="space-y-2">
            {EVENTS.map(({ key, label }) => (
              <li key={key} className="flex items-center justify-between rounded border border-white/10 px-3 py-2">
                <span className="text-sm">{label}</span>
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={preferences[key]}
                  onChange={() => toggle(key)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
