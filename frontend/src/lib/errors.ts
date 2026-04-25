/**
 * Normalises errors thrown by Freighter / stellar-wallets-kit / Soroban RPC
 * into a human-readable string.
 */

// Known Freighter rejection signals
const REJECTION_PATTERNS = [
  "user declined",
  "user rejected",
  "transaction was rejected",
  "rejected by user",
  "cancelled by user",
  "user cancel",
  "request was rejected",
  "-4",          // Freighter numeric code for user rejection
  "4001",        // EIP-1193 style rejection code used by some wallets
];

export function parseWalletError(err: unknown): string {
  const raw = normaliseToString(err);
  const lower = raw.toLowerCase();

  if (REJECTION_PATTERNS.some((p) => lower.includes(p))) {
    return "Transaction cancelled by user.";
  }

  if (lower.includes("network") || lower.includes("fetch")) {
    return "Network error — please check your connection and try again.";
  }

  if (lower.includes("insufficient") || lower.includes("balance")) {
    return "Insufficient balance to complete this transaction.";
  }

  if (lower.includes("not found") || lower.includes("meter")) {
    return "Meter not found. Please check the meter ID and try again.";
  }

  if (lower.includes("timeout")) {
    return "Transaction timed out. Please try again.";
  }

  // Fall back to a cleaned-up version of the raw message (never a raw object)
  return raw.length > 0 && raw.length < 200
    ? raw
    : "Something went wrong. Please try again.";
}

function normaliseToString(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    // Freighter sometimes throws { code: -4, message: "..." }
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.error === "string") return e.error;
    if (typeof e.code === "number") return `Error code: ${e.code}`;
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
}
