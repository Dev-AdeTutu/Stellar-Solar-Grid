import { Router } from "express";
import { z } from "zod";
import { buyoutLease, getLease, listLeaseEvents, listLeases, makeLeasePayment, startLease } from "../lib/leases.js";
export const leasesRouter = Router();
const SIGNATURES_PER_PAGE = 5;
function buildSignatureBlocks(signatories: string[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < signatories.length; i += SIGNATURES_PER_PAGE) {
    const pageSignatories = signatories.slice(i, i + SIGNATURES_PER_PAGE);
    const pageBlocks = pageSignatories.map((name, idx) => {
      const n = i + idx + 1;
      return `<div class="signature-block"><p class="signatory-name">${n}. ${name}</p><div class="signature-line">Signature: ______________________</div><div class="date-line">Date: ______________</div></div>`;
    });
    blocks.push(`<div class="signature-page">${pageBlocks.join("")}</div>`);
  }
  return blocks.join("");
}
function renderLeasePdf(lease: { id: string; signatories?: string[] }): string {
  const signatories = lease.signatories && lease.signatories.length > 0 ? lease.signatories : [];
  const signatureHtml = buildSignatureBlocks(signatories);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lease Agreement ${lease.id}</title><style>.signature-page{page-break-after:always}.signature-block{margin-bottom:24px}</style></head><body><h1>Lease Agreement</h1><p>Lease ID: ${lease.id}</p><h2>Signatures</h2>${signatureHtml}</body></html>`;
}
const startSchema = z.object({ meterId: z.string().min(1), ownerId: z.string().min(1), lesseeId: z.string().min(1), monthlyPayment: z.number().positive(), totalPayments: z.number().int().min(1).max(120), buyoutAmount: z.number().positive().optional() });
const paymentSchema = z.object({ payerId: z.string().min(1), amount: z.number().positive() });
function domain(res: any, err: unknown) { return res.status(400).json({ error: err instanceof Error ? err.message : "invalid lease request" }); }
leasesRouter.get("/", (req, res) => res.json({ leases: listLeases(typeof req.query.ownerId === "string" ? req.query.ownerId : undefined) }));
leasesRouter.post("/", (req, res) => { const parsed = startSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() }); try { return res.status(201).json(startLease(parsed.data)); } catch (e) { return domain(res, e); } });
leasesRouter.get("/:id", (req, res) => { const lease = getLease(req.params.id); return lease ? res.json({ lease, events: listLeaseEvents(lease.id) }) : res.status(404).json({ error: "lease not found" }); });
leasesRouter.post("/:id/payments", (req, res) => { const parsed = paymentSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() }); try { return res.json(makeLeasePayment(req.params.id, parsed.data.payerId, parsed.data.amount)); } catch (e) { return domain(res, e); } });
leasesRouter.post("/:id/buyout", (req, res) => { const payerId = z.object({ payerId: z.string().min(1) }).safeParse(req.body); if (!payerId.success) return res.status(400).json({ error: payerId.error.flatten() }); try { return res.json(buyoutLease(req.params.id, payerId.data.payerId)); } catch (e) { return domain(res, e); } });
leasesRouter.get("/:id/pdf", (req, res) => { const lease = getLease(req.params.id); if (!lease) return res.status(404).json({ error: "lease not found" }); res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.send(renderLeasePdf(lease as { id: string; signatories?: string[] })); });
