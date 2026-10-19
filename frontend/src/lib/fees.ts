/**
 * #762 — Pure fee-padding math, split out from contract.ts so it can be unit
 * tested without pulling in env/wallet-store (which require a full runtime
 * environment to construct). See contract.ts's padResourceFee for the
 * env-wired entry point, and backend/src/lib/stellar.ts's padResourceFee for
 * the equivalent backend-side fix.
 */
export function padResourceFee(assembledFee: string, marginPct = 20): string {
  const base = Number(assembledFee);
  if (!Number.isFinite(base) || marginPct <= 0) return assembledFee;
  return String(Math.ceil(base * (1 + marginPct / 100)));
}
