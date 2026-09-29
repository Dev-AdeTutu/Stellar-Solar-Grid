import { describe, it, expect, vi } from "vitest";

process.env.API_KEYS_DB_PATH = ":memory:";

import {
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKey,
  hashApiKey,
} from "../src/lib/apiKeys";
import { requireApiKey } from "../src/middleware/apiKeyAuth";

function mockRes() {
  const res: any = { locals: {} };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe("API key management (#833)", () => {
  it("generates a key, stores only its hash, and lists it", () => {
    const { key, record } = generateApiKey({ providerId: "prov-1", permissions: ["read", "write"] });
    expect(key).toMatch(/^sg_[0-9a-f]{64}$/);
    expect(record.provider_id).toBe("prov-1");
    expect(record.permissions).toEqual(["read", "write"]);
    expect(JSON.stringify(record)).not.toContain(key);
    expect(JSON.stringify(record)).not.toContain(hashApiKey(key));
    expect(listApiKeys("prov-1").map((k) => k.id)).toContain(record.id);
    expect(listApiKeys("other")).toHaveLength(0);
  });

  it("validates active keys and rejects revoked or unknown keys", () => {
    const { key, record } = generateApiKey({ providerId: "prov-2" });
    expect(validateApiKey(key)?.id).toBe(record.id);
    expect(validateApiKey("sg_bogus")).toBeUndefined();
    expect(revokeApiKey("someone-else", record.id)).toBe(false);
    expect(revokeApiKey("prov-2", record.id)).toBe(true);
    expect(validateApiKey(key)).toBeUndefined();
  });

  it("rejects expired keys", () => {
    const { key } = generateApiKey({ providerId: "prov-3", expiresInDays: 1 });
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(validateApiKey(key, later)).toBeUndefined();
  });

  it("middleware enforces X-API-Key header and permissions", () => {
    const { key } = generateApiKey({ providerId: "prov-4", permissions: ["read"] });
    const next = vi.fn();

    let res = mockRes();
    requireApiKey()({ header: () => undefined } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);

    res = mockRes();
    requireApiKey("write")({ header: () => key } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403);

    res = mockRes();
    requireApiKey("read")({ header: () => key } as any, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.apiKey.provider_id).toBe("prov-4");
  });
});
