"use client";

/**
 * Energy export certificates (#871): certificates held by the connected
 * wallet (or any address), PDF download and on-chain verification.
 */
import { useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import {
  activeEnergyKwh,
  certificatePdfUrl,
  fetchCertificatesByOwner,
  formatKwh,
  formatPeriod,
  isValidReadingHash,
  shortAddress,
  verifyCertificate,
  type CertificateVerification,
  type ExportCertificate,
} from "@/lib/certificates";

function StatusBadge({ status }: { status: ExportCertificate["status"] }) {
  const cls = status === "active" ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-300";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status === "active" ? "Active" : "Retired"}</span>;
}

function VerificationResult({ result }: { result: CertificateVerification }) {
  return (
    <p
      role="status"
      className={`mt-2 rounded p-2 text-sm ${result.valid ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}
    >
      {result.valid
        ? `Certificate #${result.id} is recorded on-chain with this reading hash.`
        : `No certificate #${result.id} with this reading hash exists on-chain.`}
    </p>
  );
}

function CertificateCard({ cert }: { cert: ExportCertificate }) {
  const [result, setResult] = useState<CertificateVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setVerifying(true);
    setError(null);
    try {
      setResult(await verifyCertificate(cert.id, cert.readingHash));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <li className="rounded-lg border border-white/10 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Certificate #{cert.id}</h2>
          <p className="text-2xl font-bold text-solar-yellow">{formatKwh(cert.energyKwh)}</p>
        </div>
        <StatusBadge status={cert.status} />
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <dt className="opacity-60">Meter</dt>
        <dd>{cert.meterId}</dd>
        <dt className="opacity-60">Export period</dt>
        <dd>{formatPeriod(cert.periodStart, cert.periodEnd)}</dd>
        <dt className="opacity-60">Producer</dt>
        <dd title={cert.producer}>{shortAddress(cert.producer)}</dd>
        <dt className="opacity-60">Issued</dt>
        <dd>{new Date(cert.issuedAt).toLocaleString()}</dd>
        {cert.retiredAt && (
          <>
            <dt className="opacity-60">Retired</dt>
            <dd>{new Date(cert.retiredAt).toLocaleString()}</dd>
          </>
        )}
        <dt className="opacity-60">Reading hash</dt>
        <dd className="break-all font-mono text-xs">{cert.readingHash}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={certificatePdfUrl(cert.id)}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white"
          download={`energy-certificate-${cert.id}.pdf`}
        >
          Download PDF
        </a>
        <button
          type="button"
          onClick={verify}
          disabled={verifying}
          className="rounded border border-white/20 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {verifying ? "Verifying…" : "Verify on-chain"}
        </button>
      </div>
      {result && <VerificationResult result={result} />}
      {error && <p className="mt-2 text-sm text-red-500">Verification failed: {error}</p>}
    </li>
  );
}

function VerifyForm() {
  const [id, setId] = useState("");
  const [hash, setHash] = useState("");
  const [result, setResult] = useState<CertificateVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[1-9][0-9]*$/.test(id.trim()) && isValidReadingHash(hash);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      setResult(await verifyCertificate(id.trim(), hash));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section aria-labelledby="verify-heading" className="mt-10 rounded-lg border border-white/10 p-4">
      <h2 id="verify-heading" className="font-semibold">Verify a certificate</h2>
      <p className="mb-3 text-sm opacity-70">
        Enter the certificate number and reading hash printed on a PDF certificate to check it against the blockchain.
      </p>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={onSubmit}>
        <label htmlFor="verify-id" className="sr-only">Certificate number</label>
        <input
          id="verify-id"
          className="rounded border bg-transparent px-3 py-2 sm:w-40"
          placeholder="Certificate #"
          inputMode="numeric"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <label htmlFor="verify-hash" className="sr-only">Reading hash</label>
        <input
          id="verify-hash"
          className="flex-1 rounded border bg-transparent px-3 py-2 font-mono text-xs"
          placeholder="Reading SHA-256 (64 hex characters)"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
        />
        <button type="submit" disabled={!valid} className="rounded bg-sky-600 px-4 py-2 text-white disabled:opacity-50">
          Verify
        </button>
      </form>
      {result && <VerificationResult result={result} />}
      {error && <p className="mt-2 text-sm text-red-500">Verification failed: {error}</p>}
    </section>
  );
}

export default function CertificatesPage() {
  const walletAddress = useWalletStore((s) => s.address);
  const [owner, setOwner] = useState("");
  const [query, setQuery] = useState("");
  const [certificates, setCertificates] = useState<ExportCertificate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (walletAddress && !query) {
      setOwner(walletAddress);
      setQuery(walletAddress);
    }
  }, [walletAddress, query]);

  const load = useCallback(async (address: string) => {
    setLoading(true);
    setError(null);
    try {
      setCertificates(await fetchCertificatesByOwner(address));
    } catch (e) {
      setError((e as Error).message);
      setCertificates(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (query) void load(query);
  }, [query, load]);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-4xl p-6">
        <h1 className="mb-1 text-2xl font-bold">Energy export certificates</h1>
        <p className="mb-6 text-sm opacity-70">
          Each certificate records renewable energy your meter exported to the grid. Certificates are issued on the
          Stellar blockchain and can be downloaded as PDF or verified by anyone.
        </p>

        <form
          className="mb-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(owner.trim());
          }}
        >
          <label htmlFor="cert-owner" className="sr-only">Account address</label>
          <input
            id="cert-owner"
            className="flex-1 rounded border bg-transparent px-3 py-2"
            placeholder="Stellar address (G… or C…)"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
          <button type="submit" className="rounded bg-sky-600 px-4 py-2 text-white disabled:opacity-50" disabled={!owner.trim()}>
            Show certificates
          </button>
        </form>

        {loading && <p>Loading…</p>}
        {error && <p className="text-red-500">Failed to load certificates: {error}</p>}

        {certificates && !loading && (
          certificates.length === 0 ? (
            <p className="opacity-70">No certificates held by {shortAddress(query)} yet.</p>
          ) : (
            <>
              <p className="mb-4 text-sm">
                {certificates.length} certificate{certificates.length === 1 ? "" : "s"} ·{" "}
                <strong>{formatKwh(activeEnergyKwh(certificates))}</strong> active renewable export
              </p>
              <ul className="space-y-4">
                {certificates.map((c) => (
                  <CertificateCard key={c.id} cert={c} />
                ))}
              </ul>
            </>
          )
        )}

        <VerifyForm />
      </main>
    </>
  );
}
