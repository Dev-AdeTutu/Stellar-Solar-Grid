import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { contractQuery, adminInvoke } from "../lib/stellar.js";
import { requireAdminKey } from "../middleware/adminAuth.js";

export const collaboratorRouter = Router();

export interface CollaboratorShare {
  address: string;
  basisPoints: number;
}

// Cache for total-shares (5s TTL)
let totalSharesCache: { data: object; expiresAt: number } | null = null;

/**
 * GET /api/collaborators
 *
 * Returns all collaborators and their shares in a single RPC simulation
 * of get_all_shares — eliminates the previous N+1 per-collaborator calls.
 */
collaboratorRouter.get("/", async (req, res) => {
  try {
    const raw = await contractQuery("get_all_shares", []);
    const shareMap = StellarSdk.scValToNative(raw) as Record<string, number>;

    const collaborators: CollaboratorShare[] = Object.entries(shareMap).map(
      ([address, basisPoints]) => ({ address, basisPoints }),
    );

    res.json({ collaborators });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/collaborators/total-shares — sum of all collaborator basis points.
 * Lets the frontend validate that new collaborators won't exceed 10 000 bps.
 * Cached for 5 seconds.
 *
 * Closes #463.
 */
collaboratorRouter.get("/total-shares", async (_req, res) => {
  if (totalSharesCache && Date.now() < totalSharesCache.expiresAt) {
    return res.json(totalSharesCache.data);
  }

  try {
    const raw = await contractQuery("get_all_shares", []);
    const shareMap = StellarSdk.scValToNative(raw) as Record<string, number>;

    const total_basis_points = Object.values(shareMap).reduce((s, n) => s + n, 0);
    const data = { total_basis_points, remaining: 10000 - total_basis_points };
    totalSharesCache = { data, expiresAt: Date.now() + 5_000 };
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/collaborators/meter/:meterId — list collaborators for a specific meter
 */
collaboratorRouter.get("/meter/:meterId", async (req, res) => {
  try {
    const { meterId } = req.params;
    const raw = await contractQuery("get_collaborators", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
    ]);
    const collaborators = ((StellarSdk.scValToNative(raw) as any[]) ?? []).map((c: any) => ({
      address: c.address,
      sharePercent: Number(c.share) / 100,
    }));
    return res.json({ meterId, collaborators, count: collaborators.length });
  } catch {
    return res.status(500).json({ error: "Query failed", code: "CONTRACT_ERROR" });
  }
});

/**
 * POST /api/collaborators — add a collaborator (admin only)
 * Requires X-Admin-Key header.
 */
collaboratorRouter.post("/", requireAdminKey, async (req, res) => {
  const { address, basis_points } = req.body as {
    address: string;
    basis_points: number;
  };

  if (!address || basis_points == null) {
    return res.status(400).json({ error: "address and basis_points are required" });
  }

  try {
    const hash = await adminInvoke("add_collaborator", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
      StellarSdk.nativeToScVal(basis_points, { type: "u32" }),
    ]);
    res.json({ hash });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/collaborators/:address — remove a collaborator (admin only)
 * Requires X-Admin-Key header.
 * Validates the address is a valid Stellar Ed25519 public key before invoking
 * the contract.
 *
 * Closes #343.
 */
collaboratorRouter.delete("/:address", requireAdminKey, async (req, res) => {
  const { address } = req.params;

  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }

  try {
    const hash = await adminInvoke("remove_collaborator", [
      StellarSdk.nativeToScVal(address, { type: "address" }),
    ]);
    res.json({ hash });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
