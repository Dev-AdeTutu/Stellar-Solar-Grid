/**
 * Monthly billing endpoints (#902).
 *
 *   PUT  /api/billing/accounts/:meterId       — set billing email/name (admin)
 *   GET  /api/billing/accounts/:meterId       — read billing account (admin)
 *   POST /api/billing/run                     — generate bills for a period (admin)
 *   GET  /api/billing/meters/:meterId/bills   — bill history for a meter
 *   GET  /api/billing/bills/:billId           — one bill
 *   GET  /api/billing/bills/:billId/pdf       — bill PDF
 *   POST /api/billing/bills/:billId/resend    — re-send the bill email (admin)
 *   POST /api/billing/bills/:billId/paid      — record a payment (admin)
 */
import { Router } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  emailBill,
  getBill,
  getBillingAccount,
  isValidPeriod,
  listBills,
  markBillPaid,
  previousPeriod,
  readBillPdf,
  runBillingCycle,
  upsertBillingAccount,
} from "../lib/billing.js";

export const billingRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const TX_HASH_RE = /^[0-9a-f]{64}$/i;

billingRouter.put("/accounts/:meterId", requireAdminKey, (req, res) => {
  const { email, name, stellarAddress } = req.body ?? {};
  if (email != null && (typeof email !== "string" || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: "email must be a valid email address" });
  }
  if (stellarAddress != null && (typeof stellarAddress !== "string" || !STELLAR_ADDRESS_RE.test(stellarAddress))) {
    return res.status(400).json({ error: "stellarAddress must be a valid Stellar public key" });
  }
  const account = upsertBillingAccount({
    meterId: req.params.meterId,
    email: email ?? null,
    name: typeof name === "string" ? name.slice(0, 100) : null,
    stellarAddress: stellarAddress ?? null,
  });
  res.json(account);
});

billingRouter.get("/accounts/:meterId", requireAdminKey, (req, res) => {
  const account = getBillingAccount(req.params.meterId);
  if (!account) return res.status(404).json({ error: "Billing account not found" });
  res.json(account);
});

billingRouter.post(
  "/run",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const period = (req.body?.period as string | undefined) ?? previousPeriod();
    if (!isValidPeriod(period)) return res.status(400).json({ error: "period must be YYYY-MM" });
    res.json(await runBillingCycle(period));
  }),
);

billingRouter.get("/meters/:meterId/bills", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 24) || 24, 1), 120);
  res.json({ meterId: req.params.meterId, bills: listBills(req.params.meterId, limit) });
});

billingRouter.get("/bills/:billId", (req, res) => {
  const bill = getBill(req.params.billId);
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  res.json(bill);
});

billingRouter.get("/bills/:billId/pdf", (req, res) => {
  const bill = getBill(req.params.billId);
  const pdf = bill && readBillPdf(bill.id);
  if (!bill || !pdf) return res.status(404).json({ error: "Bill not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${bill.bill_number}.pdf"`);
  res.send(pdf);
});

billingRouter.post(
  "/bills/:billId/resend",
  requireAdminKey,
  asyncHandler(async (req, res) => {
    const bill = getBill(req.params.billId);
    if (!bill) return res.status(404).json({ error: "Bill not found" });
    const delivered = await emailBill(bill);
    res.json({ delivered, bill: getBill(bill.id) });
  }),
);

billingRouter.post("/bills/:billId/paid", requireAdminKey, (req, res) => {
  const txHash = req.body?.txHash;
  if (txHash != null && (typeof txHash !== "string" || !TX_HASH_RE.test(txHash))) {
    return res.status(400).json({ error: "txHash must be a 64-character hex transaction hash" });
  }
  const bill = markBillPaid(req.params.billId, txHash ?? null);
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  res.json(bill);
});
