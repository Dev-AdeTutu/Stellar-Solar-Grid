/**
 * Energy export certificate API (#871).
 *
 *   GET  /api/certificates?owner=G...&offset=0&limit=20  certificates held by an account
 *   GET  /api/certificates/:id                             certificate metadata
 *   GET  /api/certificates/:id/pdf                         downloadable PDF certificate
 *   GET  /api/certificates/:id/verify?readingHash=<hex>    on-chain verification
 *   POST /api/certificates                                 mint (admin only)
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { CONTRACT_ID, NETWORK_PASSPHRASE, adminInvoke, contractQuery, stellarService } from "../lib/stellar.js";
import {
  createCertificatePdf,
  decodeCertificate,
  networkName,
  readingHash,
  type ExportCertificateView,
} from "../lib/exportCertificates.js";

export const certificatesRouter = Router();

const MAX_PAGE = 50;
const HEX_64 = /^[0-9a-f]{64}$/i;

const IdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/, "certificate id must be a positive integer");

const MintSchema = z
  .object({
    meterId: z.string().min(1).max(64),
    energyWh: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    periodStart: z.number().int().nonnegative(),
    periodEnd: z.number().int().positive(),
    readings: z.unknown().optional(),
  })
  .refine((v) => v.periodStart < v.periodEnd, {
    message: "periodStart must be before periodEnd",
    path: ["periodEnd"],
  })
  .refine((v) => v.periodEnd <= Math.floor(Date.now() / 1000), {
    message: "periodEnd cannot be in the future",
    path: ["periodEnd"],
  });

const u64 = (value: string | number | bigint) => StellarSdk.nativeToScVal(BigInt(value), { type: "u64" });

function isNotFound(err: unknown): boolean {
  // CertificateNotFound = #50 in the contract's error enum.
  return /Error\(Contract, #50\)/.test(err instanceof Error ? err.message : String(err));
}

async function fetchCertificate(id: string): Promise<ExportCertificateView | null> {
  try {
    const raw = await contractQuery("get_export_certificate", [u64(id)]);
    return raw ? decodeCertificate(raw) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function verifyUrl(req: { protocol: string; get(name: string): string | undefined }, id: string, hash: string) {
  const base = process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.get("host")}`;
  return `${base}/api/certificates/${id}/verify?readingHash=${hash}`;
}

certificatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const owner = String(req.query.owner ?? "");
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(owner) && !StellarSdk.StrKey.isValidContract(owner)) {
      return res.status(400).json({ error: "owner must be a Stellar account or contract address", code: "VALIDATION_ERROR" });
    }
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));

    const rawIds = await contractQuery("get_certificates_by_owner", [
      StellarSdk.nativeToScVal(owner, { type: "address" }),
      StellarSdk.nativeToScVal(offset, { type: "u32" }),
      StellarSdk.nativeToScVal(limit, { type: "u32" }),
    ]);
    const ids = ((rawIds ? StellarSdk.scValToNative(rawIds) : []) as bigint[]).map(String);
    const certificates = (await Promise.all(ids.map(fetchCertificate))).filter(
      (c): c is ExportCertificateView => c !== null,
    );
    return res.json({ owner, offset, limit, certificates });
  }),
);

certificatesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = IdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: id.error.issues[0].message, code: "VALIDATION_ERROR" });
    const cert = await fetchCertificate(id.data);
    if (!cert) return res.status(404).json({ error: "Certificate not found", code: "CERTIFICATE_NOT_FOUND" });
    return res.json({
      certificate: cert,
      verification: {
        contractId: CONTRACT_ID,
        network: networkName(NETWORK_PASSPHRASE),
        verifyUrl: verifyUrl(req, cert.id, cert.readingHash),
      },
    });
  }),
);

certificatesRouter.get(
  "/:id/pdf",
  asyncHandler(async (req, res) => {
    const id = IdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: id.error.issues[0].message, code: "VALIDATION_ERROR" });
    const cert = await fetchCertificate(id.data);
    if (!cert) return res.status(404).json({ error: "Certificate not found", code: "CERTIFICATE_NOT_FOUND" });
    const pdf = createCertificatePdf(cert, {
      contractId: CONTRACT_ID,
      network: networkName(NETWORK_PASSPHRASE),
      verifyUrl: verifyUrl(req, cert.id, cert.readingHash),
    });
    res.type("application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=energy-certificate-${cert.id}.pdf`);
    return res.send(pdf);
  }),
);

certificatesRouter.get(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    const id = IdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: id.error.issues[0].message, code: "VALIDATION_ERROR" });
    const hash = String(req.query.readingHash ?? "");
    if (!HEX_64.test(hash)) {
      return res.status(400).json({ error: "readingHash must be a 64-character hex SHA-256", code: "VALIDATION_ERROR" });
    }
    const raw = await contractQuery("verify_export_certificate", [
      u64(id.data),
      StellarSdk.nativeToScVal(Buffer.from(hash, "hex"), { type: "bytes" }),
    ]);
    const valid = raw ? StellarSdk.scValToNative(raw) === true : false;
    return res.json({ id: id.data, readingHash: hash.toLowerCase(), valid, contractId: CONTRACT_ID });
  }),
);

certificatesRouter.post(
  "/",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const parsed = MintSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR", details: parsed.error.flatten() });
    }
    const reading = parsed.data;
    const hash = readingHash(reading);
    // The backend signs as the contract admin, which the contract accepts as
    // a certificate issuer alongside the registered oracle.
    const txHash = await adminInvoke("mint_export_certificate", [
      StellarSdk.nativeToScVal(stellarService.adminKeypair.publicKey(), { type: "address" }),
      StellarSdk.nativeToScVal(reading.meterId, { type: "string" }),
      u64(reading.energyWh),
      u64(reading.periodStart),
      u64(reading.periodEnd),
      StellarSdk.nativeToScVal(Buffer.from(hash, "hex"), { type: "bytes" }),
    ]);
    return res.status(201).json({ hash: txHash, readingHash: hash });
  }),
);

export default certificatesRouter;
