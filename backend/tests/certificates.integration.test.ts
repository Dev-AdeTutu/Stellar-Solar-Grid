/**
 * Energy export certificates API (#871).
 *
 * The Stellar RPC layer is mocked; routes are exercised over HTTP against a
 * real Express app so validation, auth and response shapes are covered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

const ADMIN_KEY = "test-admin-key";
const ADMIN = StellarSdk.Keypair.random();
const PRODUCER = StellarSdk.Keypair.random().publicKey();
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const mocks = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
  return {
    contractQuery: vi.fn(),
    adminInvoke: vi.fn(),
    stellarService: { adminKeypair: undefined as unknown },
  };
});

vi.mock("../src/lib/stellar", () => ({
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  contractQuery: mocks.contractQuery,
  adminInvoke: mocks.adminInvoke,
  stellarService: mocks.stellarService,
}));

import { certificatesRouter } from "../src/routes/certificates";
import {
  canonicalJson,
  createCertificatePdf,
  decodeCertificate,
  readingHash,
} from "../src/lib/exportCertificates";

mocks.stellarService.adminKeypair = ADMIN;

const HASH = "ab".repeat(32);

/** Build the ScVal the contract returns for an ExportCertificate. */
function certificateScVal(overrides: { id?: bigint; retiredAt?: bigint | null } = {}) {
  const u64 = (v: bigint) => StellarSdk.nativeToScVal(v, { type: "u64" });
  const entry = (key: string, val: StellarSdk.xdr.ScVal) =>
    new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol(key), val });
  const retired =
    overrides.retiredAt == null ? StellarSdk.xdr.ScVal.scvVoid() : u64(overrides.retiredAt);
  // Soroban serialises struct fields as a map sorted by field name.
  return StellarSdk.xdr.ScVal.scvMap([
    entry("energy_wh", u64(12_500n)),
    entry("id", u64(overrides.id ?? 7n)),
    entry("issued_at", u64(1_700_000_600n)),
    entry("issuer", StellarSdk.nativeToScVal(ADMIN.publicKey(), { type: "address" })),
    entry("meter_id", StellarSdk.nativeToScVal("SOLAR-1", { type: "string" })),
    entry("owner", StellarSdk.nativeToScVal(PRODUCER, { type: "address" })),
    entry("period_end", u64(1_700_000_000n)),
    entry("period_start", u64(1_699_913_600n)),
    entry("producer", StellarSdk.nativeToScVal(PRODUCER, { type: "address" })),
    entry("reading_hash", StellarSdk.nativeToScVal(Buffer.from(HASH, "hex"), { type: "bytes" })),
    entry("retired_at", retired),
  ]);
}

describe("export certificate helpers", () => {
  it("serialises readings canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
    const a = readingHash({ meterId: "M", energyWh: 5, periodStart: 1, periodEnd: 2 });
    const b = readingHash({ periodEnd: 2, periodStart: 1, energyWh: 5, meterId: "M" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(readingHash({ meterId: "M", energyWh: 6, periodStart: 1, periodEnd: 2 })).not.toBe(a);
  });

  it("decodes the contract struct into API JSON", () => {
    const cert = decodeCertificate(certificateScVal());
    expect(cert).toEqual({
      id: "7",
      meterId: "SOLAR-1",
      producer: PRODUCER,
      owner: PRODUCER,
      energyWh: "12500",
      energyKwh: 12.5,
      periodStart: new Date(1_699_913_600_000).toISOString(),
      periodEnd: new Date(1_700_000_000_000).toISOString(),
      issuedAt: new Date(1_700_000_600_000).toISOString(),
      issuer: ADMIN.publicKey(),
      readingHash: HASH,
      retiredAt: null,
      status: "active",
    });
    const retired = decodeCertificate(certificateScVal({ retiredAt: 1_700_001_000n }));
    expect(retired.status).toBe("retired");
    expect(retired.retiredAt).toBe(new Date(1_700_001_000_000).toISOString());
  });

  it("renders a PDF with the metadata and verification data", () => {
    const pdf = createCertificatePdf(decodeCertificate(certificateScVal()), {
      contractId: CONTRACT,
      network: "Stellar Testnet",
    }).toString("utf8");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    for (const expected of ["Certificate #7", "12.5 kWh", "SOLAR-1", PRODUCER, CONTRACT, HASH, "startxref"]) {
      expect(pdf).toContain(expected);
    }
  });
});

describe("certificates routes", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/certificates", certificatesRouter);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/certificates`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    mocks.contractQuery.mockReset();
    mocks.adminInvoke.mockReset();
  });

  it("returns certificate metadata with verification info", async () => {
    mocks.contractQuery.mockResolvedValueOnce(certificateScVal());
    const res = await fetch(`${base}/7`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.certificate.id).toBe("7");
    expect(body.verification.contractId).toBe(CONTRACT);
    expect(body.verification.verifyUrl).toContain(`/api/certificates/7/verify?readingHash=${HASH}`);
    expect(mocks.contractQuery.mock.calls[0][0]).toBe("get_export_certificate");
  });

  it("maps the contract's CertificateNotFound error to 404", async () => {
    mocks.contractQuery.mockRejectedValueOnce(new Error("HostError: Error(Contract, #50)"));
    const res = await fetch(`${base}/99`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("CERTIFICATE_NOT_FOUND");
  });

  it("rejects malformed ids", async () => {
    for (const bad of ["0", "abc", "-1", "1.5"]) {
      const res = await fetch(`${base}/${bad}`);
      expect(res.status).toBe(400);
    }
    expect(mocks.contractQuery).not.toHaveBeenCalled();
  });

  it("serves the certificate as a PDF download", async () => {
    mocks.contractQuery.mockResolvedValueOnce(certificateScVal());
    const res = await fetch(`${base}/7/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=energy-certificate-7.pdf");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
  });

  it("lists certificates held by an owner", async () => {
    mocks.contractQuery.mockImplementation(async (method: string, args: StellarSdk.xdr.ScVal[]) => {
      if (method === "get_certificates_by_owner") {
        expect(StellarSdk.scValToNative(args[0])).toBe(PRODUCER);
        expect(StellarSdk.scValToNative(args[2])).toBe(50); // limit is capped
        return StellarSdk.xdr.ScVal.scvVec(
          [1n, 2n].map((v) => StellarSdk.nativeToScVal(v, { type: "u64" })),
        );
      }
      const id = StellarSdk.scValToNative(args[0]) as bigint;
      return certificateScVal({ id });
    });
    const res = await fetch(`${base}?owner=${PRODUCER}&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.certificates.map((c: { id: string }) => c.id)).toEqual(["1", "2"]);
  });

  it("requires a valid owner address to list", async () => {
    const res = await fetch(`${base}?owner=nope`);
    expect(res.status).toBe(400);
  });

  it("verifies a reading hash on-chain", async () => {
    mocks.contractQuery.mockResolvedValueOnce(StellarSdk.xdr.ScVal.scvBool(true));
    const res = await fetch(`${base}/7/verify?readingHash=${HASH.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "7", valid: true, readingHash: HASH });
    const [method, args] = mocks.contractQuery.mock.calls[0];
    expect(method).toBe("verify_export_certificate");
    expect(Buffer.from(StellarSdk.scValToNative(args[1]) as Uint8Array).toString("hex")).toBe(HASH);

    const bad = await fetch(`${base}/7/verify?readingHash=xyz`);
    expect(bad.status).toBe(400);
  });

  describe("minting", () => {
    const now = Math.floor(Date.now() / 1000);
    const reading = { meterId: "SOLAR-1", energyWh: 12_500, periodStart: now - 86_400, periodEnd: now - 60 };
    const post = (body: unknown, key: string | null = ADMIN_KEY) =>
      fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "X-Admin-Key": key } : {}) },
        body: JSON.stringify(body),
      });

    it("requires the admin key", async () => {
      expect((await post(reading, null)).status).toBe(401);
      expect((await post(reading, "wrong")).status).toBe(401);
      expect(mocks.adminInvoke).not.toHaveBeenCalled();
    });

    it("mints with the admin as issuer and the canonical reading hash", async () => {
      mocks.adminInvoke.mockResolvedValueOnce("tx-hash-1");
      const res = await post({ ...reading, readings: [{ t: 1, wh: 12_500 }] });
      expect(res.status).toBe(201);
      const body = await res.json();
      const expectedHash = readingHash({ ...reading, readings: [{ t: 1, wh: 12_500 }] });
      expect(body).toEqual({ hash: "tx-hash-1", readingHash: expectedHash });

      const [method, args] = mocks.adminInvoke.mock.calls[0];
      expect(method).toBe("mint_export_certificate");
      expect(StellarSdk.scValToNative(args[0])).toBe(ADMIN.publicKey());
      expect(StellarSdk.scValToNative(args[1])).toBe("SOLAR-1");
      expect(StellarSdk.scValToNative(args[2])).toBe(12_500n);
      expect(Buffer.from(StellarSdk.scValToNative(args[5]) as Uint8Array).toString("hex")).toBe(expectedHash);
    });

    it("validates the export period and energy", async () => {
      const cases = [
        { ...reading, energyWh: 0 },
        { ...reading, periodStart: reading.periodEnd },
        { ...reading, periodEnd: now + 3_600 },
        { ...reading, meterId: "" },
      ];
      for (const body of cases) {
        expect((await post(body)).status).toBe(400);
      }
      expect(mocks.adminInvoke).not.toHaveBeenCalled();
    });
  });
});
