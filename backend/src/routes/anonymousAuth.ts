/**
 * Anonymous meter authentication endpoints (#1058).
 *
 *   GET  /api/anon-auth/public-key          — issuer RSA public key { n, e } (hex)
 *   POST /api/anon-auth/meters/:deviceId    — mark a meter verified (X-Admin-Key)
 *   POST /api/anon-auth/issue               — { deviceId, blinded: hex[] } → { signatures }
 *   GET  /api/anon-auth/nonce               — single-use challenge nonce
 *   POST /api/anon-auth/verify              — { serial, signature, nonce } → { sessionId }
 */
import { Router } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  ISSUANCE_QUOTA,
  createNonce,
  issueBlindSignatures,
  publicKey,
  registerVerifiedMeter,
  verifyCredential,
} from "../lib/anonymousAuth.js";

export const anonymousAuthRouter = Router();

const hex = z.string().regex(/^[0-9a-f]+$/i).max(1024);

anonymousAuthRouter.get("/public-key", (_req, res) => res.json(publicKey()));

anonymousAuthRouter.post("/meters/:deviceId", requireAdminKey, (req, res) => {
  registerVerifiedMeter(req.params.deviceId);
  res.status(201).json({ deviceId: req.params.deviceId, verified: true });
});

anonymousAuthRouter.post("/issue", (req, res) => {
  const parsed = z.object({ deviceId: z.string().min(1), blinded: z.array(hex).min(1).max(ISSUANCE_QUOTA) })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid issuance request", details: parsed.error.issues });
  try {
    res.status(201).json({ signatures: issueBlindSignatures(parsed.data.deviceId, parsed.data.blinded) });
  } catch (err) {
    res.status(403).json({ error: (err as Error).message });
  }
});

anonymousAuthRouter.get("/nonce", (_req, res) => res.json({ nonce: createNonce() }));

anonymousAuthRouter.post("/verify", (req, res) => {
  const parsed = z.object({ serial: z.string().min(16).max(128), signature: hex, nonce: z.string().min(1) })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid credential", details: parsed.error.issues });
  const result = verifyCredential(parsed.data.serial, parsed.data.signature, parsed.data.nonce);
  if (!result.ok) return res.status(401).json({ error: result.reason });
  res.json({ sessionId: result.sessionId });
});
