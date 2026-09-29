/**
 * Energy token staking endpoints (#899). Read-only — stake/unstake/claim are
 * signed client-side by the user's wallet against the contract.
 *
 *   GET /api/staking/stats                       — pool totals, APR, reserve runway
 *   GET /api/staking/:address                    — a staker's position
 *   GET /api/staking/:address/voting-power       — governance voting power
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getStakerInfo, getStakingStats, getVotingPower } from "../lib/staking.js";

export const stakingRouter = Router();

const validAddress = (a: string) =>
  StellarSdk.StrKey.isValidEd25519PublicKey(a) || StellarSdk.StrKey.isValidContract(a);

stakingRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    res.json(await getStakingStats());
  }),
);

stakingRouter.get(
  "/:address",
  asyncHandler(async (req, res) => {
    if (!validAddress(req.params.address)) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    res.json(await getStakerInfo(req.params.address));
  }),
);

stakingRouter.get(
  "/:address/voting-power",
  asyncHandler(async (req, res) => {
    if (!validAddress(req.params.address)) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }
    res.json({ address: req.params.address, votingPower: await getVotingPower(req.params.address) });
  }),
);
