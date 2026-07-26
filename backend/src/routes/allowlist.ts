import { Router } from 'express';
import * as StellarSdk from '@stellar/stellar-sdk';
import { stellarService } from '../lib/stellar.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAdminKey } from '../middleware/adminAuth.js';
import { z } from 'zod';

export const allowlistRouter = Router();
const AddressSchema = z.object({ address: z.string().length(56) });

/** GET /api/allowlist — get all allowlisted addresses */
allowlistRouter.get('/', asyncHandler(async (_req, res) => {
  const result = await stellarService.query('get_allowlist', []);
  res.json({ addresses: StellarSdk.scValToNative(result) });
}));

/** GET /api/allowlist/:address — check if a single address is allowlisted */
allowlistRouter.get('/:address', asyncHandler(async (req, res) => {
  const address = req.params.address;

  // Validate address is a valid Stellar public key
  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(address);
  } catch {
    return res.status(400).json({ 
      error: 'Invalid Stellar address', 
      code: 'VALIDATION_ERROR' 
    });
  }

  // Query the allowlist and check membership
  const result = await stellarService.query('get_allowlist', []);
  const allowlist: string[] = (StellarSdk.scValToNative(result) as string[]) ?? [];
  const allowed = allowlist.includes(address);

  return res.status(200).json({ address, allowed });
}));

/** POST /api/allowlist — add address to allowlist */
allowlistRouter.post('/', requireAdminKey, asyncHandler(async (req, res) => {
  const { address } = AddressSchema.parse(req.body);
  const hash = await stellarService.invoke('allowlist_add', [
    StellarSdk.nativeToScVal(address, { type: 'address' }),
  ]);
  res.json({ hash });
}));

/** DELETE /api/allowlist/:address — remove address from allowlist */
allowlistRouter.delete('/:address', requireAdminKey, asyncHandler(async (req, res) => {
  const hash = await stellarService.invoke('allowlist_remove', [
    StellarSdk.nativeToScVal(req.params.address, { type: 'address' }),
  ]);
  res.json({ hash });
}));
