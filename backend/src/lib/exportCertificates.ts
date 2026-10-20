/**
 * Energy export certificates (#871).
 *
 * Certificates are minted and stored on-chain by the SolarGrid contract. This
 * module converts the contract representation into API-friendly JSON, derives
 * the reading hash the issuer commits to, and renders downloadable PDFs.
 *
 * Verification model: every certificate stores the SHA-256 of the canonical
 * meter-reading payload it was minted from (`reading_hash`). The PDF prints
 * the certificate id, contract id and that hash, so anyone can call
 * `verify_export_certificate(id, hash)` on-chain without trusting this server.
 */
import crypto from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createTextPdf, type PdfLine } from "./pdf.js";

export type ExportCertificateView = {
  id: string;
  meterId: string;
  producer: string;
  owner: string;
  /** Exported energy in watt-hours (milli-kWh), as a decimal string. */
  energyWh: string;
  energyKwh: number;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  issuer: string;
  readingHash: string;
  retiredAt: string | null;
  status: "active" | "retired";
  /** Certificate authority fields (#1065). */
  standard: string;
  standardVersion: string;
  proof: string;
  attestations: CertificateAttestation[];
  revokedAt: string | null;
  revocationReason: string | null;
};

export type CertificateAttestation = {
  verifier: string;
  /** Unix seconds when the attestation was recorded. */
  attestedAt: string;
  /** SHA-256 (hex) of the verifier's signed attestation payload. */
  attestationHash: string;
};

export type ExportReading = {
  meterId: string;
  energyWh: number;
  /** Unix seconds, inclusive. */
  periodStart: number;
  /** Unix seconds, exclusive. */
  periodEnd: number;
  /** Optional raw interval readings backing the total. */
  readings?: unknown;
};

/** Stable JSON serialisation: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the canonical reading payload a certificate commits to. */
export function readingHash(reading: ExportReading): string {
  return crypto.createHash("sha256").update(canonicalJson(reading)).digest("hex");
}

function toIso(seconds: bigint | number): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** Convert the `ExportCertificate` returned by the contract into API JSON. */
export function decodeCertificate(raw: StellarSdk.xdr.ScVal): ExportCertificateView {
  const native = StellarSdk.scValToNative(raw) as {
    id: bigint;
    meter_id: string;
    producer: string;
    owner: string;
    energy_wh: bigint;
    period_start: bigint;
    period_end: bigint;
    issued_at: bigint;
    issuer: string;
    reading_hash: Uint8Array;
    retired_at?: bigint | null;
    standard?: string;
    standard_version?: string;
    proof?: Uint8Array;
    attestations?: Array<{
      verifier: string;
      attested_at: bigint;
      attestation_hash: Uint8Array;
    }>;
    revoked_at?: bigint | null;
    revocation_reason?: string | null;
  };
  const retiredAt = native.retired_at == null ? null : toIso(native.retired_at);
  const revokedAt = native.revoked_at == null ? null : toIso(native.revoked_at);
  const attestations: CertificateAttestation[] = (native.attestations ?? []).map((a) => ({
    verifier: a.verifier,
    attestedAt: toIso(a.attested_at),
    attestationHash: Buffer.from(a.attestation_hash).toString("hex"),
  }));
  return {
    id: native.id.toString(),
    meterId: native.meter_id,
    producer: native.producer,
    owner: native.owner,
    energyWh: native.energy_wh.toString(),
    energyKwh: Number(native.energy_wh) / 1000,
    periodStart: toIso(native.period_start),
    periodEnd: toIso(native.period_end),
    issuedAt: toIso(native.issued_at),
    issuer: native.issuer,
    readingHash: Buffer.from(native.reading_hash).toString("hex"),
    retiredAt,
    status: retiredAt ? "retired" : "active",
    standard: native.standard ?? "I-REC",
    standardVersion: native.standard_version ?? "1.0",
    proof: native.proof ? Buffer.from(native.proof).toString("hex") : "",
    attestations,
    revokedAt,
    revocationReason: native.revocation_reason ?? null,
  };
}

export type CertificateVerificationInfo = {
  contractId: string;
  network: string;
  verifyUrl?: string;
};

/** Render a one-page PDF certificate including on-chain verification data. */
export function createCertificatePdf(
  cert: ExportCertificateView,
  verification: CertificateVerificationInfo,
): Buffer {
  const lines: PdfLine[] = [
    { text: "Renewable Energy Export Certificate", size: 20, bold: true },
    "",
    { text: `Certificate #${cert.id}`, size: 16, bold: true },
    `Status: ${cert.status === "retired" ? `Retired on ${cert.retiredAt}` : "Active"}`,
    ...(cert.revokedAt
      ? [
          { text: `REVOKED on ${cert.revokedAt}`, size: 12, bold: true } as PdfLine,
          `Revocation reason: ${cert.revocationReason ?? "unspecified"}`,
        ]
      : []),
    "",
    { text: "Energy exported to the grid", bold: true },
    `${cert.energyKwh.toLocaleString("en-US", { maximumFractionDigits: 3 })} kWh (${cert.energyWh} Wh)`,
    `Period: ${cert.periodStart} to ${cert.periodEnd}`,
    "",
    { text: "Producer", bold: true },
    `Meter: ${cert.meterId}`,
    `Producer account: ${cert.producer}`,
    `Current holder: ${cert.owner}`,
    "",
    { text: "Issuance", bold: true },
    `Issued at: ${cert.issuedAt}`,
    `Issuer: ${cert.issuer}`,
    `Standard: ${cert.standard} v${cert.standardVersion}`,
    "",
    { text: "Third-party attestations", bold: true },
    ...(cert.attestations.length === 0
      ? [{ text: "None recorded", size: 10 } as PdfLine]
      : cert.attestations.map(
          (a) =>
            ({
              text: `${a.verifier} at ${a.attestedAt} (${a.attestationHash})`,
              size: 9,
            }) as PdfLine,
        )),
    "",
    { text: "On-chain verification", bold: true },
    { text: `Network: ${verification.network}`, size: 10 },
    { text: `Contract: ${verification.contractId}`, size: 10 },
    { text: `Reading SHA-256: ${cert.readingHash}`, size: 9 },
    ...(cert.proof ? [{ text: `Proof: ${cert.proof}`, size: 9 } as PdfLine] : []),
    {
      text: `Verify: call verify_export_certificate(${cert.id}, <reading SHA-256>) on the contract.`,
      size: 9,
    },
  ];
  if (verification.verifyUrl) lines.push({ text: `Or visit: ${verification.verifyUrl}`, size: 9 });
  return createTextPdf(lines, { fontSize: 12, lineHeight: 20 });
}

export function networkName(passphrase: string): string {
  if (passphrase === StellarSdk.Networks.PUBLIC) return "Stellar Public Network";
  if (passphrase === StellarSdk.Networks.TESTNET) return "Stellar Testnet";
  return passphrase;
}
