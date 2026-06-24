import { Router } from "express";
import { adminInvoke, contractQuery } from "../lib/stellar.js";
import * as StellarSdk from "@stellar/stellar-sdk";

export const allowlistRouter = Router();

/**
 * GET /api/allowlist
 * Returns the current list of allowlisted Stellar addresses.
 */
allowlistRouter.get("/", async (_req, res) => {
  try {
    const result = await contractQuery("get_allowlist", []);
    const addresses = StellarSdk.scValToNative(result) as string[];
    return res.json({ addresses });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Failed to fetch allowlist" });
  }
});

/**
 * POST /api/allowlist
 * Add an address to the allowlist. Requires X-Admin-Key header.
 *
 * Body: { "address": "<Stellar address>" }
 */
allowlistRouter.post("/", async (req, res) => {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { address } = req.body as { address?: string };
  if (!address) {
    return res.status(400).json({ error: "address is required" });
  }

  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }

  try {
    const hash = await adminInvoke("add_to_allowlist", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    return res.status(200).json({ hash, address });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Failed to add address" });
  }
});

/**
 * DELETE /api/allowlist/:address
 * Remove an address from the allowlist. Requires X-Admin-Key header.
 */
allowlistRouter.delete("/:address", async (req, res) => {
  const adminKey = req.headers["x-admin-key"] as string | undefined;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { address } = req.params;

  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }

  try {
    const hash = await adminInvoke("remove_from_allowlist", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    return res.status(200).json({ hash, address });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Failed to remove address" });
  }
});
