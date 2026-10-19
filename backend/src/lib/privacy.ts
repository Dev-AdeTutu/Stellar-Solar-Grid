/**
 * Energy data privacy controls (#939).
 *
 * Per wallet owner we keep:
 *   - privacy settings (sharing level, anonymization, analytics/research opt-in)
 *   - third-party access grants (scoped, revocable, optionally expiring)
 *   - a data-usage log (who accessed/exported which data, and when)
 *
 * `anonymize` strips PII fields and replaces identifiers with a salted hash so
 * shared records cannot be linked back to a person.
 */
import crypto from "node:crypto";

export type SharingLevel = "none" | "aggregate" | "full";
export type DataScope = "usage" | "billing" | "meter" | "location";

export type PrivacySettings = {
  sharingLevel: SharingLevel;
  anonymize: boolean;
  allowAnalytics: boolean;
  allowResearch: boolean;
  updatedAt: string;
};

export type ThirdPartyGrant = {
  id: string;
  thirdParty: string;
  scopes: DataScope[];
  grantedAt: string;
  expiresAt: string | null;
};

export type DataUsageEntry = { at: string; actor: string; action: string; scopes: DataScope[] };

type OwnerPrivacy = { settings: PrivacySettings; grants: ThirdPartyGrant[]; usage: DataUsageEntry[] };

const MAX_USAGE_ENTRIES = 500;
const SALT = process.env.PRIVACY_ANON_SALT ?? crypto.randomBytes(16).toString("hex");
const PII_FIELDS = new Set(["name", "email", "phone", "address", "owner", "ip", "location", "latitude", "longitude", "notes"]);
const ID_FIELDS = new Set(["meter_id", "meterId", "userId", "wallet"]);

const owners = new Map<string, OwnerPrivacy>();

function defaults(): PrivacySettings {
  return { sharingLevel: "aggregate", anonymize: true, allowAnalytics: true, allowResearch: false, updatedAt: new Date().toISOString() };
}

function entry(owner: string): OwnerPrivacy {
  let p = owners.get(owner);
  if (!p) {
    p = { settings: defaults(), grants: [], usage: [] };
    owners.set(owner, p);
  }
  return p;
}

const activeGrants = (p: OwnerPrivacy, now = Date.now()) =>
  p.grants.filter((g) => !g.expiresAt || Date.parse(g.expiresAt) > now);

export function getSettings(owner: string): PrivacySettings {
  return entry(owner).settings;
}

export function updateSettings(owner: string, patch: Partial<Omit<PrivacySettings, "updatedAt">>): PrivacySettings {
  const p = entry(owner);
  p.settings = { ...p.settings, ...patch, updatedAt: new Date().toISOString() };
  return p.settings;
}

export function listGrants(owner: string): ThirdPartyGrant[] {
  return activeGrants(entry(owner));
}

export function addGrant(owner: string, thirdParty: string, scopes: DataScope[], expiresAt?: string): ThirdPartyGrant {
  const p = entry(owner);
  const grant: ThirdPartyGrant = {
    id: crypto.randomUUID(),
    thirdParty,
    scopes: [...new Set(scopes)],
    grantedAt: new Date().toISOString(),
    expiresAt: expiresAt ?? null,
  };
  p.grants = [...activeGrants(p).filter((g) => g.thirdParty !== thirdParty), grant];
  return grant;
}

export function revokeGrant(owner: string, id: string): boolean {
  const p = entry(owner);
  const before = p.grants.length;
  p.grants = p.grants.filter((g) => g.id !== id);
  return p.grants.length < before;
}

/** Whether a third party may read `scope` for this owner (respects sharing level). */
export function canAccess(owner: string, thirdParty: string, scope: DataScope): boolean {
  const p = entry(owner);
  if (p.settings.sharingLevel === "none") return false;
  return activeGrants(p).some((g) => g.thirdParty === thirdParty && g.scopes.includes(scope));
}

export function recordDataUsage(owner: string, actor: string, action: string, scopes: DataScope[]): void {
  const p = entry(owner);
  p.usage.push({ at: new Date().toISOString(), actor, action, scopes });
  if (p.usage.length > MAX_USAGE_ENTRIES) p.usage.splice(0, p.usage.length - MAX_USAGE_ENTRIES);
}

export function getDashboard(owner: string) {
  const p = entry(owner);
  const byActor: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const u of p.usage) {
    byActor[u.actor] = (byActor[u.actor] ?? 0) + 1;
    for (const s of u.scopes) byScope[s] = (byScope[s] ?? 0) + 1;
  }
  return {
    settings: p.settings,
    grants: activeGrants(p),
    usage: { total: p.usage.length, byActor, byScope, recent: p.usage.slice(-20).reverse() },
  };
}

const pseudonym = (value: unknown) =>
  crypto.createHmac("sha256", SALT).update(String(value)).digest("hex").slice(0, 16);

/** Remove PII and pseudonymize identifiers in a record (recursively). */
export function anonymize<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => anonymize(v)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELDS.has(k)) continue;
    out[k] = ID_FIELDS.has(k) ? pseudonym(v) : anonymize(v);
  }
  return out as T;
}

export function exportOwnerData(owner: string) {
  const p = entry(owner);
  return { owner, settings: p.settings, grants: p.grants, usage: p.usage };
}

export function deleteOwnerData(owner: string): void {
  owners.delete(owner);
}

export function _resetPrivacy(): void {
  owners.clear();
}
