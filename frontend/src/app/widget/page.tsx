"use client";

/** Wallet widget settings (#938): configure the price alerts shown on the home-screen widget. */
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { usePaymentStore } from "@/store/paymentStore";
import { env } from "@/lib/env";

const API = `${env.NEXT_PUBLIC_BACKEND_URL}/api/widgets/alerts`;

type Alert = { id: string; direction: "above" | "below"; price: number };

export default function WidgetSettingsPage() {
  const meterId = usePaymentStore((s) => s.meterId).trim();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [direction, setDirection] = useState<Alert["direction"]>("below");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!meterId) return;
    try {
      const res = await fetch(`${API}?meterId=${encodeURIComponent(meterId)}`);
      setAlerts(((await res.json()) as { alerts: Alert[] }).alerts ?? []);
    } catch {
      setError("Could not load alerts");
    }
  }, [meterId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meterId, direction, price: Number(price) }),
    });
    if (!res.ok)
      return setError(((await res.json()) as { error?: string }).error ?? "Could not add alert");
    setPrice("");
    void load();
  }

  async function remove(id: string) {
    await fetch(`${API}/${id}?meterId=${encodeURIComponent(meterId)}`, { method: "DELETE" });
    void load();
  }

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-xl p-4 space-y-4">
        <h1 className="text-2xl font-bold">Widget price alerts</h1>
        {!meterId ? (
          <p className="text-sm opacity-70">Select a meter on the dashboard first.</p>
        ) : (
          <>
            <form onSubmit={add} className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                Alert when price is
                <select
                  className="block rounded border border-white/20 bg-transparent px-2 py-1 text-sm"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as Alert["direction"])}
                >
                  <option value="below">at or below</option>
                  <option value="above">at or above</option>
                </select>
              </label>
              <label className="text-xs">
                XLM/kWh
                <input
                  className="block w-28 rounded border border-white/20 bg-transparent px-2 py-1 text-sm"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </label>
              <button className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white">
                Add alert
              </button>
            </form>
            {error && (
              <p className="text-sm text-red-400" role="alert">
                {error}
              </p>
            )}
            <ul className="divide-y divide-white/10">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    Price {a.direction === "below" ? "≤" : "≥"} {a.price} XLM/kWh
                  </span>
                  <button className="text-red-400" onClick={() => remove(a.id)}>
                    Remove
                  </button>
                </li>
              ))}
              {alerts.length === 0 && (
                <li className="py-2 text-sm opacity-70">No alerts configured.</li>
              )}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
