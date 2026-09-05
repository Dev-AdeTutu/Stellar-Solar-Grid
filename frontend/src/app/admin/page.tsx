"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const STROOPS_PER_XLM = 10_000_000;

/**
 * Admin form for daily usage caps (closes #758): set a meter's max daily
 * spend and whether exceeding it blocks usage (auto-deactivate) or only
 * warns.
 */
function DailyCapForm() {
  const [meterId, setMeterId] = useState("");
  const [limitXlm, setLimitXlm] = useState("");
  const [autoDeactivate, setAutoDeactivate] = useState(true);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function authHeaders(): Record<string, string> {
    const token = sessionStorage.getItem("admin_token");
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const trimmedId = meterId.trim();
    const limitNum = Number(limitXlm);
    if (!trimmedId) {
      setStatus({ kind: "error", text: "Meter ID is required" });
      return;
    }
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      setStatus({ kind: "error", text: "Daily cap must be a non-negative number of XLM (0 = unlimited)" });
      return;
    }

    setSubmitting(true);
    try {
      const limitStroops = Math.round(limitNum * STROOPS_PER_XLM);
      const limitRes = await fetch(`${API}/api/meters/${encodeURIComponent(trimmedId)}/set-daily-limit`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ limit: limitStroops }),
      });
      const limitData = await limitRes.json();
      if (!limitRes.ok) {
        setStatus({ kind: "error", text: limitData.error ?? "Failed to set daily limit" });
        return;
      }

      const modeRes = await fetch(`${API}/api/meters/${encodeURIComponent(trimmedId)}/set-cap-mode`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ autoDeactivate }),
      });
      const modeData = await modeRes.json();
      if (!modeRes.ok) {
        setStatus({ kind: "error", text: modeData.error ?? "Failed to set cap mode" });
        return;
      }

      setStatus({
        kind: "ok",
        text:
          limitNum === 0
            ? `Daily cap removed for ${trimmedId}`
            : `Daily cap set to ${limitNum} XLM/day for ${trimmedId} (${autoDeactivate ? "auto-deactivate" : "warn only"})`,
      });
    } catch {
      setStatus({ kind: "error", text: "Network error — could not reach server" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-white/10 bg-solar-accent p-6 space-y-4 w-full max-w-2xl"
    >
      <h2 className="text-lg font-semibold text-white">Daily Usage Cap</h2>
      <p className="text-xs text-gray-400">
        Limit how much a meter can spend per day. Alerts fire at 80% and 100% of
        the cap; choose whether reaching 100% blocks further usage or only warns.
      </p>

      <div>
        <label htmlFor="cap-meter-id" className="block text-sm font-medium text-gray-300 mb-1.5">
          Meter ID
        </label>
        <input
          id="cap-meter-id"
          type="text"
          value={meterId}
          onChange={(e) => setMeterId(e.target.value)}
          required
          disabled={submitting}
          className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
        />
      </div>

      <div>
        <label htmlFor="cap-limit" className="block text-sm font-medium text-gray-300 mb-1.5">
          Daily cap (XLM/day, 0 = unlimited)
        </label>
        <input
          id="cap-limit"
          type="number"
          min={0}
          step="any"
          value={limitXlm}
          onChange={(e) => setLimitXlm(e.target.value)}
          required
          disabled={submitting}
          className="w-full rounded-lg border border-white/10 bg-solar-dark px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-solar-yellow focus:outline-none transition"
        />
      </div>

      <fieldset disabled={submitting}>
        <legend className="block text-sm font-medium text-gray-300 mb-1.5">
          When the cap is reached
        </legend>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="radio"
              name="cap-mode"
              checked={autoDeactivate}
              onChange={() => setAutoDeactivate(true)}
              className="accent-solar-yellow"
            />
            Auto-deactivate — block further usage (default)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="radio"
              name="cap-mode"
              checked={!autoDeactivate}
              onChange={() => setAutoDeactivate(false)}
              className="accent-solar-yellow"
            />
            Warn only — keep the meter running
          </label>
        </div>
      </fieldset>

      {status && (
        <p className={`text-xs ${status.kind === "ok" ? "text-green-400" : "text-red-400"}`}>
          {status.text}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-solar-yellow py-3 text-sm font-semibold text-solar-dark hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {submitting ? "Saving…" : "Save daily cap"}
      </button>
    </form>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!sessionStorage.getItem("admin_token")) {
      router.replace("/admin/login");
    } else {
      setReady(true);
    }
  }, [router]);

  function handleLogout() {
    sessionStorage.removeItem("admin_token");
    router.replace("/admin/login");
  }

  if (!ready) return null;

  return (
    <>
      <Navbar />
      <main className="min-h-screen flex flex-col items-center px-4 py-8 sm:py-16 gap-8">
        <div className="w-full max-w-2xl">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-solar-yellow">Admin Dashboard</h1>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-400 hover:text-red-400 border border-white/10 rounded-lg px-3 py-1.5 transition"
            >
              Sign Out
            </button>
          </div>
          <p className="text-gray-400 text-sm mb-6">
            You are authenticated. Admin actions are available here.
          </p>
        </div>
        <DailyCapForm />
      </main>
    </>
  );
}
