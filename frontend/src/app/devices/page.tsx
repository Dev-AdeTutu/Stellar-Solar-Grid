"use client";

/**
 * Energy device registry (#897): register panels, inverters and meters, and
 * see certifications, upcoming maintenance and recent performance.
 */
import { FormEvent, useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type DeviceType = "solar_panel" | "inverter" | "meter" | "battery";
type Device = {
  id: string;
  type: DeviceType;
  owner: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  meterId: string | null;
  location: string | null;
  status: string;
  specs: Record<string, unknown>;
};
type Certification = { id: string; standard: string; issuer: string; expiresAt: string | null; valid: boolean };
type Maintenance = { id: string; deviceId: string; task: string; intervalDays: number; nextDueAt: string };
type DeviceDetail = Device & { certifications: Certification[]; maintenance: Maintenance[] };
type PerfSummary = {
  readings: number;
  totalEnergyKwh: number;
  avgPowerW: number | null;
  peakPowerW: number | null;
  capacityFactor: number | null;
  latestStateOfCharge: number | null;
  storageCapacityKwh: number | null;
  availableStorageKwh: number | null;
  totalChargedEnergyKwh: number;
  totalDischargedEnergyKwh: number;
  roundTripEfficiency: number | null;
};

const TYPE_LABEL: Record<DeviceType, string> = { solar_panel: "Solar panel", inverter: "Inverter", meter: "Meter", battery: "Battery" };
const INPUT = "rounded border border-white/20 bg-transparent px-3 py-2 text-sm";
const BTN = "rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function DeviceRow({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [perf, setPerf] = useState<PerfSummary | null>(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([
      api<DeviceDetail>(`/api/devices/${device.id}`),
      api<{ summary: PerfSummary }>(`/api/devices/${device.id}/performance?days=7`),
    ]);
    setDetail(d);
    setPerf(p.summary);
  }, [device.id]);

  useEffect(() => {
    if (!open) return;
    load().catch((e) => showToast({ title: e.message, variant: "error" }));
    if (device.type !== "battery") return;
    const timer = setInterval(() => {
      load().catch((e) => showToast({ title: e.message, variant: "error" }));
    }, 10_000);
    return () => clearInterval(timer);
  }, [open, device.type, load, showToast]);

  const complete = async (m: Maintenance) => {
    try {
      await api(`/api/devices/${device.id}/maintenance/${m.id}/complete`, { method: "POST", body: "{}" });
      showToast({ title: `Marked "${m.task}" done` });
      await load();
      onChanged();
    } catch (e) {
      showToast({ title: (e as Error).message, variant: "error" });
    }
  };

  const addMaintenance = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api(`/api/devices/${device.id}/maintenance`, {
        method: "POST",
        body: JSON.stringify({ task: form.get("task"), intervalDays: Number(form.get("intervalDays")) }),
      });
      (e.target as HTMLFormElement).reset();
      await load();
      onChanged();
    } catch (err) {
      showToast({ title: (err as Error).message, variant: "error" });
    }
  };

  return (
    <li className="rounded-lg border border-white/10">
      <button
        className="w-full flex flex-wrap items-center justify-between gap-2 p-4 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>
          <span className="font-medium">{device.manufacturer} {device.model}</span>
          <span className="opacity-60 text-sm"> · {TYPE_LABEL[device.type]} · SN {device.serialNumber}</span>
        </span>
        <span className="text-xs uppercase opacity-70">{device.status}</span>
      </button>
      {open && detail && (
        <div className="border-t border-white/10 p-4 grid gap-4 md:grid-cols-3 text-sm">
          <div>
            <h3 className="font-semibold mb-2">Performance (7 days)</h3>
            {perf && perf.readings > 0 ? (
              <ul className="space-y-1 tabular-nums">
                <li>Energy: {perf.totalEnergyKwh.toFixed(2)} kWh</li>
                <li>Avg power: {perf.avgPowerW === null ? "—" : `${Math.round(perf.avgPowerW)} W`}</li>
                <li>Peak power: {perf.peakPowerW === null ? "—" : `${Math.round(perf.peakPowerW)} W`}</li>
                {device.type === "battery" ? (
                  <>
                    <li>State of charge: {perf.latestStateOfCharge === null ? "—" : `${(perf.latestStateOfCharge * 100).toFixed(1)}%`}</li>
                    <li>Available: {perf.availableStorageKwh === null ? "—" : `${perf.availableStorageKwh.toFixed(2)} / ${perf.storageCapacityKwh?.toFixed(2)} kWh`}</li>
                    <li>Charged / discharged: {perf.totalChargedEnergyKwh.toFixed(2)} / {perf.totalDischargedEnergyKwh.toFixed(2)} kWh</li>
                    <li>Round-trip efficiency: {perf.roundTripEfficiency === null ? "—" : `${(perf.roundTripEfficiency * 100).toFixed(1)}%`}</li>
                  </>
                ) : (
                  <li>Capacity factor: {perf.capacityFactor === null ? "—" : `${(perf.capacityFactor * 100).toFixed(1)}%`}</li>
                )}
              </ul>
            ) : (
              <p className="opacity-60">No telemetry yet. Devices publish to solargrid/devices/{device.id}/telemetry.</p>
            )}
          </div>
          <div>
            <h3 className="font-semibold mb-2">Certifications</h3>
            {detail.certifications.length === 0 && <p className="opacity-60">None recorded.</p>}
            <ul className="space-y-1">
              {detail.certifications.map((c) => (
                <li key={c.id}>
                  {c.standard} <span className="opacity-60">({c.issuer})</span>{" "}
                  {c.expiresAt && (
                    <span className={c.valid ? "opacity-60" : "text-red-400"}>
                      {c.valid ? "exp." : "expired"} {new Date(c.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Maintenance</h3>
            <ul className="space-y-2 mb-3">
              {detail.maintenance.map((m) => {
                const overdue = new Date(m.nextDueAt) < new Date();
                return (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span>
                      {m.task}{" "}
                      <span className={overdue ? "text-red-400" : "opacity-60"}>
                        {overdue ? "overdue since" : "due"} {new Date(m.nextDueAt).toLocaleDateString()}
                      </span>
                    </span>
                    <button className={BTN} onClick={() => complete(m)}>Done</button>
                  </li>
                );
              })}
            </ul>
            <form onSubmit={addMaintenance} className="flex flex-wrap gap-2">
              <input name="task" required placeholder="Task (e.g. Clean panels)" className={`${INPUT} flex-1 min-w-0`} />
              <input name="intervalDays" required type="number" min={1} defaultValue={90} className={`${INPUT} w-20`} aria-label="Interval (days)" />
              <button className={BTN} type="submit">Schedule</button>
            </form>
          </div>
        </div>
      )}
    </li>
  );
}

export default function DevicesPage() {
  const { address } = useWalletStore();
  const { showToast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [due, setDue] = useState<Maintenance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registerType, setRegisterType] = useState<DeviceType>("solar_panel");

  const load = useCallback(async () => {
    try {
      const query = address ? `?owner=${encodeURIComponent(address)}` : "";
      const [list, dueList] = await Promise.all([
        api<{ devices: Device[] }>(`/api/devices${query}`),
        api<{ maintenance: Maintenance[] }>(`/api/devices/maintenance/due?withinDays=7`),
      ]);
      setDevices(list.devices);
      const mine = new Set(list.devices.map((d) => d.id));
      setDue(dueList.maintenance.filter((m) => mine.has(m.deviceId)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);

  const register = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!address) return;
    const f = new FormData(e.currentTarget);
    const specs: Record<string, number | boolean> = {};
    for (const key of ["ratedPowerW", "latitude", "longitude"]) {
      const v = String(f.get(key) ?? "").trim();
      if (v) specs[key] = Number(v);
    }
    if (registerType === "battery") {
      for (const key of ["capacityKwh", "chargePriceBelow", "dischargePriceAbove"]) {
        specs[key] = Number(f.get(key));
      }
      specs.automationEnabled = f.get("automationEnabled") === "on";
    }
    setSubmitting(true);
    try {
      await api("/api/devices", {
        method: "POST",
        body: JSON.stringify({
          type: f.get("type"),
          owner: address,
          manufacturer: f.get("manufacturer"),
          model: f.get("model"),
          serialNumber: f.get("serialNumber"),
          meterId: String(f.get("meterId") ?? "").trim() || null,
          location: String(f.get("location") ?? "").trim() || null,
          specs,
        }),
      });
      (e.target as HTMLFormElement).reset();
      showToast({ title: "Device registered" });
      await load();
    } catch (err) {
      showToast({ title: "Registration failed", description: (err as Error).message, variant: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Device Registry</h1>
        {error && <p className="text-red-500 mb-4">Failed to load devices: {error}</p>}

        {due.length > 0 && (
          <section className="mb-6 rounded-xl border border-yellow-500/30 bg-yellow-900/10 p-4" aria-label="Maintenance due">
            <h2 className="font-semibold mb-2">Maintenance due this week</h2>
            <ul className="text-sm space-y-1">
              {due.map((m) => {
                const d = devices.find((x) => x.id === m.deviceId);
                return (
                  <li key={m.id}>
                    {m.task} — {d ? `${d.manufacturer} ${d.model}` : m.deviceId} ({new Date(m.nextDueAt).toLocaleDateString()})
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {address ? (
          <form onSubmit={register} className="mb-8 rounded-lg border border-white/10 p-4 grid gap-3 md:grid-cols-3">
            <h2 className="font-semibold md:col-span-3">Register a device</h2>
            <select name="type" className={INPUT} value={registerType} onChange={(e) => setRegisterType(e.target.value as DeviceType)} aria-label="Device type">
              <option value="solar_panel">Solar panel</option>
              <option value="inverter">Inverter</option>
              <option value="meter">Meter</option>
              <option value="battery">Battery storage</option>
            </select>
            <input name="manufacturer" required placeholder="Manufacturer" className={INPUT} />
            <input name="model" required placeholder="Model" className={INPUT} />
            <input name="serialNumber" required placeholder="Serial number" className={INPUT} />
            <input name="meterId" placeholder="Linked meter ID (optional)" className={INPUT} />
            <input name="location" placeholder="Location (optional)" className={INPUT} />
            <input name="ratedPowerW" type="number" min={0} placeholder="Rated power (W)" className={INPUT} />
            <input name="latitude" type="number" step="any" min={-90} max={90} placeholder="Latitude (for weather)" className={INPUT} />
            <input name="longitude" type="number" step="any" min={-180} max={180} placeholder="Longitude (for weather)" className={INPUT} />
            {registerType === "battery" && (
              <>
                <input name="capacityKwh" type="number" step="any" min="0.01" required placeholder="Storage capacity (kWh)" className={INPUT} />
                <input name="chargePriceBelow" type="number" step="any" min="0" required placeholder="Charge at or below price" className={INPUT} />
                <input name="dischargePriceAbove" type="number" step="any" min="0" required placeholder="Discharge at or above price" className={INPUT} />
                <label className="flex items-center gap-2 text-sm">
                  <input name="automationEnabled" type="checkbox" defaultChecked />
                  Enable automatic dispatch
                </label>
              </>
            )}
            <div className="md:col-span-3">
              <button type="submit" disabled={submitting} className={BTN}>
                {submitting ? "Registering…" : "Register device"}
              </button>
            </div>
          </form>
        ) : (
          <p className="mb-6 opacity-80">Connect your wallet to register devices.</p>
        )}

        {devices.length === 0 ? (
          <p className="opacity-60">No devices registered yet.</p>
        ) : (
          <ul className="space-y-3">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} onChanged={load} />
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
