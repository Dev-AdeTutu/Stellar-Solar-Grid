import { Router } from "express";
import QRCode from "qrcode";
import * as StellarSdk from "@stellar/stellar-sdk";
import { asyncHandler } from "../lib/asyncHandler.js";
import { StellarService } from "../lib/stellar.js";

export function createMeterQrRouter(stellar: StellarService) {
  const router = Router();
  router.get("/:meterId/qr", asyncHandler(async (req, res) => {
    const meterId = String(req.params.meterId);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(meterId)) {
      return res.status(400).json({ error: "Invalid meter ID", code: "VALIDATION_ERROR" });
    }
    let meter: any;
    try {
      meter = await stellar.query("get_meter", [StellarSdk.nativeToScVal(meterId, { type: "symbol" })]);
    } catch {
      return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
    }
    if (!meter) return res.status(404).json({ error: "Meter not found", code: "METER_NOT_FOUND" });
    const payload = {
      version: 1,
      type: "stellar-solar-grid-meter",
      meter_id: meterId,
      owner: String(meter.owner),
      metadata: {
        active: Boolean(meter.active),
        plan: String(meter.plan ?? "Unknown"),
        expires_at: Number(meter.expires_at ?? 0),
      },
    };
    const image = await QRCode.toBuffer(JSON.stringify(payload), { type: "png", width: 512, margin: 2 });
    res.type("png");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(image);
  }));
  return router;
}
