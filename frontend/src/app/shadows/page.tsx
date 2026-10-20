'use client';

import { useCallback, useState } from 'react';

/** Meter shadow state viewer (#1081): desired vs reported. See backend/SHADOWS.md. */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

interface ShadowResponse {
  meterId: string;
  desired: Record<string, unknown>;
  reported: Record<string, unknown>;
  delta: Record<string, unknown>;
  version: number;
  online: boolean;
  lastSeenAt: string | null;
}

interface HistoryEntry {
  version: number;
  at: string;
  source: string;
  changes: Record<string, unknown>;
  note?: string;
}

const fmt = (v: unknown) => (v === undefined ? '—' : JSON.stringify(v));

export default function ShadowsPage() {
  const [meterId, setMeterId] = useState('');
  const [shadow, setShadow] = useState<ShadowResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [patch, setPatch] = useState('{"relay":"on"}');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!meterId) return;
    setError(null);
    try {
      const id = encodeURIComponent(meterId);
      const [s, h] = await Promise.all([
        fetch(`${API_BASE}/api/shadows/${id}`).then((r) => r.json()),
        fetch(`${API_BASE}/api/shadows/${id}/history?limit=20`).then((r) => r.json()),
      ]);
      setShadow(s);
      setHistory(h.history ?? []);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [meterId]);

  const setDesired = async () => {
    try {
      const body = JSON.parse(patch);
      const res = await fetch(`${API_BASE}/api/shadows/${encodeURIComponent(meterId)}/desired`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `Request failed (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const keys = shadow ? [...new Set([...Object.keys(shadow.desired), ...Object.keys(shadow.reported)])].sort() : [];

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Meter Shadow State</h1>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input className="rounded border px-2 py-1" placeholder="Meter ID" value={meterId} onChange={(e) => setMeterId(e.target.value)} required />
        <button className="rounded bg-yellow-500 px-4 py-1 font-semibold text-black">Load</button>
      </form>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {shadow && (
        <>
          <p className="text-sm">
            Status: <strong className={shadow.online ? 'text-green-600' : 'text-gray-500'}>{shadow.online ? 'online' : 'offline'}</strong>
            {' · '}version {shadow.version}
            {shadow.lastSeenAt && ` · last seen ${new Date(shadow.lastSeenAt).toLocaleString()}`}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left"><th>Key</th><th>Desired</th><th>Reported</th><th>In sync</th></tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const pending = k in shadow.delta;
                return (
                  <tr key={k} className={`border-t ${pending ? 'bg-yellow-50' : ''}`}>
                    <td className="font-mono">{k}</td>
                    <td>{fmt(shadow.desired[k])}</td>
                    <td>{fmt(shadow.reported[k])}</td>
                    <td>{pending ? 'pending' : '✓'}</td>
                  </tr>
                );
              })}
              {keys.length === 0 && (
                <tr><td colSpan={4} className="text-gray-500">No state yet.</td></tr>
              )}
            </tbody>
          </table>
          <div className="flex gap-2">
            <input className="flex-1 rounded border px-2 py-1 font-mono" value={patch} onChange={(e) => setPatch(e.target.value)} aria-label="Desired state patch (JSON)" />
            <button className="rounded border px-4 py-1" onClick={setDesired} type="button">Set desired</button>
          </div>
          <section>
            <h2 className="mb-2 text-lg font-semibold">History</h2>
            <ul className="space-y-1 text-sm">
              {history.map((h) => (
                <li key={h.version} className="font-mono">
                  v{h.version} {new Date(h.at).toLocaleString()} [{h.source}] {JSON.stringify(h.changes)} {h.note ?? ''}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
