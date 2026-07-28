import { Router } from "express";
import {
  NETWORK_PASSPHRASE,
  CONTRACT_ID,
  RPC_URL,
  HORIZON_URL,
} from "../lib/stellar.js";

export const configRouter = Router();

/**
 * GET /api/config — non-secret runtime config for frontend bootstrap.
 * No admin key required; only exposes values already public on-chain/in the client bundle.
 */
configRouter.get("/", (_req, res) => {
  res.json({
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: CONTRACT_ID,
    rpcUrl: RPC_URL,
    horizonUrl: HORIZON_URL,
  });
});
