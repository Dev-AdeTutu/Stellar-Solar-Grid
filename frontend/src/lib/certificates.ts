/**
 * Client for the energy export certificate API (#871).
 */
import { env } from "@/lib/env";

export type ExportCertificate = {
  id: string;
  meterId: string;
  producer: string;
  owner: string;
  energyWh: string;
  energyKwh: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  issuer: string;
  readingHash: string;
  retiredAt: string | null;
  status: "active" | "retired";
};

export type CertificateVerification = {
  id: string;
  readingHash: string;
  valid: boolean;
  contractId: string;
};

const API = env.NEXT_PUBLIC_BACKEND_URL;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

export async function fetchCertificatesByOwner(owner: string, offset = 0, limit = 20): Promise<ExportCertificate[]> {
  const params = new URLSearchParams({ owner, offset: String(offset), limit: String(limit) });
  const data = await getJson<{ certificates: ExportCertificate[] }>(`${API}/api/certificates?${params}`);
  return data.certificates;
}

export async function verifyCertificate(id: string, readingHash: string): Promise<CertificateVerification> {
  const params = new URLSearchParams({ readingHash: readingHash.trim().toLowerCase() });
  return getJson<CertificateVerification>(`${API}/api/certificates/${encodeURIComponent(id)}/verify?${params}`);
}

export function certificatePdfUrl(id: string): string {
  return `${API}/api/certificates/${encodeURIComponent(id)}/pdf`;
}

export function isValidReadingHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

export function formatKwh(kwh: number): string {
  return `${kwh.toLocaleString(undefined, { maximumFractionDigits: 3 })} kWh`;
}

export function formatPeriod(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" };
  return `${new Date(startIso).toLocaleString(undefined, opts)} – ${new Date(endIso).toLocaleString(undefined, opts)} UTC`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Total exported energy (kWh) across certificates that have not been retired. */
export function activeEnergyKwh(certificates: ExportCertificate[]): number {
  return certificates.filter((c) => c.status === "active").reduce((sum, c) => sum + c.energyKwh, 0);
}
