import { useCallback, useEffect, useState } from "react";
import { env } from "@/lib/env";

const BACKEND_URL = env.NEXT_PUBLIC_BACKEND_URL;

interface ConfigVersion {
  meterId: string;
  version: number;
  source: string;
  note?: string;
  createdAt: string;
  config: Record<string, unknown>;
}

/** Meter configuration backup history and one-click restore (#1055). */
export function MeterConfigManager({ meterId, adminKey }: { meterId: string; adminKey?: string }) {
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${BACKEND_URL}/api/meter-config/${encodeURIComponent(meterId)}/versions`);
    if (res.ok) setVersions(await res.json());
  }, [meterId]);

  useEffect(() => { load(); }, [load]);

  async function restore(version: number) {
    if (!target) return setMessage("Enter a replacement meter ID");
    const res = await fetch(`${BACKEND_URL}/api/meter-config/${encodeURIComponent(target)}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(adminKey ? { "X-Admin-Key": adminKey } : {}) },
      body: JSON.stringify({ sourceMeterId: meterId, version }),
    });
    setMessage(res.ok ? `Restored v${version} to ${target}` : `Restore failed (${res.status})`);
  }

  return (
    <section aria-label="Meter configuration backups">
      <h3>Configuration backups — {meterId}</h3>
      <label>
        Replacement meter ID{" "}
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="METER-002" />
      </label>
      {message && <p role="status">{message}</p>}
      {versions.length === 0 ? (
        <p>No backups yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Version</th><th>Source</th><th>Saved</th><th>Config</th><th /></tr>
          </thead>
          <tbody>
            {[...versions].reverse().map((v) => (
              <tr key={v.version}>
                <td>v{v.version}</td>
                <td>{v.source}{v.note ? ` (${v.note})` : ""}</td>
                <td>{new Date(v.createdAt).toLocaleString()}</td>
                <td><code>{JSON.stringify(v.config)}</code></td>
                <td><button onClick={() => restore(v.version)}>Restore</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
