/**
 * Provider API key endpoints (#833).
 *
 *   POST   /api/keys/generate   — create a key (plaintext returned once)
 *   GET    /api/keys            — list the provider's keys (no secrets)
 *   DELETE /api/keys/:keyId     — revoke a key
 *
 * The provider is identified by the `X-Provider-Id` header. Management routes
 * are protected by the admin key (X-Admin-Key).
 */
import { Router, type Request, type Response } from "express";
import { requireAdminKey } from "../middleware/adminAuth.js";
import {
  API_KEY_PERMISSIONS,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyPermission,
} from "../lib/apiKeys.js";

export const apiKeysRouter = Router();

apiKeysRouter.use(requireAdminKey);

function providerId(req: Request, res: Response): string | undefined {
  const id = req.header("X-Provider-Id")?.trim();
  if (!id) {
    res.status(400).json({ error: "X-Provider-Id header is required" });
    return undefined;
  }
  return id;
}

apiKeysRouter.post("/generate", (req, res) => {
  const provider = providerId(req, res);
  if (!provider) return;
  const { name, permissions, expiresInDays } = req.body ?? {};

  if (permissions !== undefined) {
    if (
      !Array.isArray(permissions) ||
      !permissions.every((p: unknown) => API_KEY_PERMISSIONS.includes(p as ApiKeyPermission))
    ) {
      return res
        .status(400)
        .json({ error: `permissions must be a subset of ${API_KEY_PERMISSIONS.join(", ")}` });
    }
  }
  if (
    expiresInDays !== undefined &&
    (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)
  ) {
    return res.status(400).json({ error: "expiresInDays must be an integer between 1 and 3650" });
  }

  const { key, record } = generateApiKey({
    providerId: provider,
    name: typeof name === "string" ? name.slice(0, 100) : undefined,
    permissions,
    expiresInDays,
  });
  res.status(201).json({ key, ...record });
});

apiKeysRouter.get("/", (req, res) => {
  const provider = providerId(req, res);
  if (!provider) return;
  res.json({ keys: listApiKeys(provider) });
});

apiKeysRouter.delete("/:keyId", (req, res) => {
  const provider = providerId(req, res);
  if (!provider) return;
  if (!revokeApiKey(provider, req.params.keyId)) {
    return res.status(404).json({ error: "API key not found" });
  }
  res.status(204).end();
});
