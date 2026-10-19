import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra as {
  backendUrl?: string;
  webAppUrl?: string;
} | undefined;

export const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL ?? extra?.backendUrl ?? "").replace(/\/$/, "");
export const WEB_APP_URL = (process.env.EXPO_PUBLIC_WEB_APP_URL ?? extra?.webAppUrl ?? "").replace(/\/$/, "");

export type MeterSummary = {
  meter_id: string;
  balance: string | number;
  units_used: string | number;
  active: boolean;
  is_low_balance: boolean;
};

export type UsageEvent = { received_at: string; units: number; cost: string | number };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BACKEND_URL) throw new Error("Set EXPO_PUBLIC_BACKEND_URL in mobile/.env");
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export async function loadMeters(ownerAddress: string): Promise<MeterSummary[]> {
  const { meters } = await api<{ meters: string[] }>(`/api/meters/owner/${encodeURIComponent(ownerAddress)}`);
  const results = await Promise.allSettled(meters.map((id) =>
    api<MeterSummary>(`/api/meters/${encodeURIComponent(id)}/balance`),
  ));
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

export async function loadUsage(meterId: string): Promise<UsageEvent[]> {
  const result = await api<{ events: UsageEvent[] }>(
    `/api/meters/${encodeURIComponent(meterId)}/history?page=1&pageSize=7`,
  );
  return result.events ?? [];
}