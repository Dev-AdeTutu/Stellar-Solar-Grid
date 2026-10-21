/**
 * Client for the energy export certificate API (#871).
 */
import { env } from "@/lib/env";

export type CertificateStandard = "I-REC" | "REC" | "GO" | "TIGR";

export type CertificateAttestation = {
  verifier: string;
  verifiedAt: string;
  signature: string;
  note?: string;
};

export type CertificateProof = {
  algorithm: string;
  digest: string;
  signature: string;
  publicKey: string;
};

export type CertificateRevocation = {
  revokedAt: string;
  revokedBy: string;
  reason: string;
};

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
  status: "active" | "retired" | "revoked";
  standard: CertificateStandard;
  proof: CertificateProof;
  attestations: CertificateAttestation[];
  revocation: CertificateRevocation | null;
};

export type CertificateVerification = {
  id: string;
  readingHash: string;
  valid: boolean;
  contractId: string;
  standard: CertificateStandard;
  proofValid: boolean;
  attestationsValid: boolean;
  revoked: boolean;
  revocation: CertificateRevocation | null;
};

export type IssueCertificateInput = {
  meterId: string;
  owner: string;
  energyWh: string;
  periodStart: string;
  periodEnd: string;
  readingHash: string;
  standard: CertificateStandard;
};

export type RevokeCertificateInput = {
  reason: string;
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

async function sendJson<T>(url: string, method: "POST" | "DELETE", payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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

export async function issueCertificate(input: IssueCertificateInput): Promise<ExportCertificate> {
  const data = await sendJson<{ certificate: ExportCertificate }>(`${API}/api/certificates`, "POST", {
    ...input,
    readingHash: input.readingHash.trim().toLowerCase(),
  });
  return data.certificate;
}

export async function verifyCertificate(id: string, readingHash: string): Promise<CertificateVerification> {
  const params = new URLSearchParams({ readingHash: readingHash.trim().toLowerCase() });
  return getJson<CertificateVerification>(`${API}/api/certificates/${encodeURIComponent(id)}/verify?${params}`);
}

export async function revokeCertificate(id: string, input: RevokeCertificateInput): Promise<ExportCertificate> {
  const data = await sendJson<{ certificate: ExportCertificate }>(
    `${API}/api/certificates/${encodeURIComponent(id)}/revoke`,
    "POST",
    input,
  );
  return data.certificate;
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

/** Total exported energy (kWh) across certificates that have not been retired or revoked. */
export function activeEnergyKwh(certificates: ExportCertificate[]): number {
  return certificates.filter((c) => c.status === "active").reduce((sum, c) => sum + c.energyKwh, 0);
}

export function isRevoked(certificate: ExportCertificate): boolean {
  return certificate.status === "revoked" || certificate.revocation !== null;
}

export function hasValidProof(certificate: ExportCertificate): boolean {
  return certificate.proof.digest.length > 0 && certificate.proof.signature.length > 0;
}
