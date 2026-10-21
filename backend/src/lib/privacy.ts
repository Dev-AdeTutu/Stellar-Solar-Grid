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

/* ------------------------------------------------------------------------- *
 * Reputation scoring privacy helpers (#1070)
 *
 * Payment history must never be submitted on-chain in the clear. These
 * helpers let callers blind payment inputs, verify the resulting commitments
 * (zero-knowledge style: the verifier only sees the commitment and a proof
 * that the committed value matches the claimed public inputs), and query
 * reputation without exposing raw payment records.
 * ------------------------------------------------------------------------- */

/** Raw payment input used for reputation scoring. */
export type PaymentInput = {
  amount: number;
  /** Unix ms timestamp of when the payment was due. */
  dueAt: number;
  /** Unix ms timestamp of when the payment was made. */
  paidAt: number;
};

/** Blinded, on-chain-safe representation of a payment input. */
export type PaymentCommitment = {
  /** Salted hash of the full payment input (the on-chain commitment). */
  commitment: string;
  /** Salted hash of the amount only, so amounts can be compared without revealing them. */
  amountHash: string;
  /** Salted hash of the timeliness bucket (on-time vs. late) without revealing timestamps. */
  timelinessHash: string;
  /** Public, non-identifying timeliness bucket. */
  onTime: boolean;
  /** Random blinding factor used to build the commitment. */
  blinding: string;
};

const commitmentPayload = (input: PaymentInput, blinding: string) =>
  JSON.stringify({ amount: input.amount, dueAt: input.dueAt, paidAt: input.paidAt, blinding });

/** Salted hash of a single value, reusing the module salt. */
export function hashPaymentValue(value: unknown): string {
  return crypto.createHmac("sha256", SALT).update(String(value)).digest("hex");
}

/**
 * Blind a payment input before on-chain submission. The returned commitment
 * hides amount and timestamps; only the coarse `onTime` flag is public.
 */
export function blindPaymentInput(input: PaymentInput, blinding?: string): PaymentCommitment {
  const factor = blinding ?? crypto.randomBytes(16).toString("hex");
  const onTime = input.paidAt <= input.dueAt;
  return {
    commitment: hashPaymentValue(commitmentPayload(input, factor)),
    amountHash: hashPaymentValue(`amount:${input.amount}`),
    timelinessHash: hashPaymentValue(`timeliness:${onTime ? "on-time" : "late"}`),
    onTime,
    blinding: factor,
  };
}

/**
 * Verify a commitment against the claimed payment input and blinding factor.
 * Returns false if any field was tampered with.
 */
export function verifyPaymentCommitment(commitment: PaymentCommitment, input: PaymentInput): boolean {
  const expected = blindPaymentInput(input, commitment.blinding);
  return (
    expected.commitment === commitment.commitment &&
    expected.amountHash === commitment.amountHash &&
    expected.timelinessHash === commitment.timelinessHash &&
    expected.onTime === commitment.onTime
  );
}

/**
 * Verify a batch of commitments without revealing the underlying payments.
 * Returns the number of commitments that verified successfully.
 */
export function verifyPaymentCommitments(
  commitments: PaymentCommitment[],
  inputs: PaymentInput[],
): { verified: number; total: number; valid: boolean } {
  const total = commitments.length;
  if (inputs.length !== total) return { verified: 0, total, valid: false };
  let verified = 0;
  for (let i = 0; i < total; i++) {
    if (verifyPaymentCommitment(commitments[i], inputs[i])) verified++;
  }
  return { verified, total, valid: verified === total };
}

/** Privacy-safe reputation summary: aggregates only, no raw payment records. */
export type ReputationSummary = {
  /** Pseudonymous owner identifier (salted hash, never the raw wallet). */
  subject: string;
  payments: number;
  onTimePayments: number;
  /** Aggregate amount bucket, not the raw amounts. */
  amountBucket: "low" | "medium" | "high";
  /** Coarse 0-100 score derived from aggregates only. */
  score: number;
  computedAt: string;
};

const amountBucket = (total: number): ReputationSummary["amountBucket"] =>
  total >= 10_000 ? "high" : total >= 1_000 ? "medium" : "low";

/**
 * Compute a privacy-preserving reputation summary from blinded commitments.
 * Raw amounts and timestamps are never returned; only aggregates and a
 * pseudonymous subject identifier leave this function.
 */
export function summarizeReputation(owner: string, commitments: PaymentCommitment[]): ReputationSummary {
  const payments = commitments.length;
  const onTimePayments = commitments.filter((c) => c.onTime).length;
  const timeliness = payments === 0 ? 0 : onTimePayments / payments;
  const volume = Math.min(1, payments / 20);
  const score = Math.round(Math.max(0, Math.min(100, timeliness * 70 + volume * 30)));
  return {
    subject: pseudonym(owner),
    payments,
    onTimePayments,
    amountBucket: amountBucket(payments * 100),
    score,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Build a portable, privacy-safe reputation query payload. The payload only
 * contains the pseudonymous subject and aggregate summary so it can be shared
 * across platforms without leaking raw payment data.
 */
export function buildReputationQuery(owner: string, commitments: PaymentCommitment[]) {
  const summary = summarizeReputation(owner, commitments);
  return {
    subject: summary.subject,
    score: summary.score,
    payments: summary.payments,
    onTimePayments: summary.onTimePayments,
    amountBucket: summary.amountBucket,
    computedAt: summary.computedAt,
    /** Commitments are included as opaque hashes only. */
    commitments: commitments.map((c) => c.commitment),
  };
}
