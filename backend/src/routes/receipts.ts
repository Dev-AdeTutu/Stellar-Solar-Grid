import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getReceipt, readReceiptPdf } from "../lib/receipts.js";

export const receiptsRouter = Router();

receiptsRouter.get("/:paymentId", asyncHandler(async (req, res) => {
  const paymentId = String(req.params.paymentId);
  const pdf = readReceiptPdf(paymentId);
  if (!pdf) return res.status(404).json({ error: "Receipt not found", code: "RECEIPT_NOT_FOUND" });
  res.type("application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=receipt-${paymentId}.pdf`);
  return res.send(pdf);
}));

export default receiptsRouter;
