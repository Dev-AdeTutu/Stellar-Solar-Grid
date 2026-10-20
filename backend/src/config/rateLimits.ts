/**
 * config/rateLimits.ts — single source of truth for all rate-limiter config.
 *
 * Closes #539: previously, middleware/rateLimit.ts and index.ts each parsed
 * the same RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX env vars independently,
 * creating two diverging sources of truth that could silently drift apart.
 *
 * Both files now import from here so any future tuning only needs to happen
 * in one place.
 */

/** Anonymous request window in milliseconds (default: 15 minutes). */
export const RATE_LIMIT_WINDOW_MS = Number(
  process.env.RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000,
);

/**
 * Maximum requests per window for the general / global limiter (default: 100).
 * This is also used as the ceiling for read-heavy routes.
 */
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 100);

/**
 * Maximum write requests per window for the strict write limiter (default:
 * 30).  Used by writeLimiter (admin login, webhooks, allowlist, etc.).
 * Setting this lower than RATE_LIMIT_MAX intentionally throttles mutating
 * operations harder than reads.
 */
export const WRITE_RATE_LIMIT_MAX = Number(
  process.env.WRITE_RATE_LIMIT_MAX ?? 30,
);

/**
 * Maximum payer-scoped payment and meter-management requests per hour
 * (default: 50). Payments hit the Stellar network and cost gas, so they get a
 * tighter budget than generic anonymous reads.
 */
export const PAYMENTS_RATE_LIMIT_WINDOW_MS = Number(
  process.env.PAYMENTS_RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000,
);
export const PAYMENTS_RATE_LIMIT_MAX = Number(
  process.env.PAYMENTS_RATE_LIMIT_MAX ?? 50,
);

/** Human-readable message returned to clients that exceed any limiter. */
export const RATE_LIMIT_MESSAGE =
  process.env.RATE_LIMIT_MESSAGE ??
  "Too many requests, please try again later.";

/* -------------------------------------------------------------------------
 * Regulatory sandbox mode (#1064)
 *
 * Sandbox mode lets regulatory-sensitive features be exercised against
 * synthetic data without touching production compliance state.  The flag is
 * read once here so every consumer shares a single source of truth.
 * ---------------------------------------------------------------------- */

/** True when the process is running in the isolated regulatory sandbox. */
export const SANDBOX_MODE: boolean =
  (process.env.SANDBOX_MODE ?? "").toLowerCase() === "true" ||
  process.env.SANDBOX_MODE === "1";

/** Environment label used to scope feature flags. */
export type SandboxEnvironment = "sandbox" | "production";

/** The environment this process is running in. */
export const CURRENT_ENVIRONMENT: SandboxEnvironment = SANDBOX_MODE
  ? "sandbox"
  : "production";

/**
 * Registry of experimental features and the environments in which each is
 * enabled.  A feature listed only under `sandbox` is invisible to production
 * compliance paths; promoting it means adding `production` to its list.
 */
export interface FeatureFlagDefinition {
  /** Short human-readable description of the experimental feature. */
  description: string;
  /** Environments where the feature is currently enabled. */
  enabledIn: SandboxEnvironment[];
  /** Whether the feature touches regulatory/compliance logic. */
  regulatorySensitive: boolean;
}

export const FEATURE_FLAGS: Record<string, FeatureFlagDefinition> = {
  "sandbox.synthetic-data": {
    description: "Generate synthetic payer, meter and payment records.",
    enabledIn: ["sandbox"],
    regulatorySensitive: false,
  },
  "sandbox.compliance-isolation": {
    description: "Route compliance writes to the isolated sandbox store.",
    enabledIn: ["sandbox"],
    regulatorySensitive: true,
  },
  "sandbox.experimental-settlement": {
    description: "Experimental settlement flow under evaluation.",
    enabledIn: ["sandbox"],
    regulatorySensitive: true,
  },
};

/** Returns true when `feature` is enabled in the given environment. */
export function isFeatureEnabled(
  feature: string,
  environment: SandboxEnvironment = CURRENT_ENVIRONMENT,
): boolean {
  const definition = FEATURE_FLAGS[feature];
  if (!definition) return false;
  return definition.enabledIn.includes(environment);
}

/** Returns true when `feature` is enabled in the current environment. */
export function isFeatureEnabledHere(feature: string): boolean {
  return isFeatureEnabled(feature, CURRENT_ENVIRONMENT);
}

/**
 * Returns true only when the feature is enabled in the sandbox and is
 * regulatory-sensitive — i.e. it must never leak into production until
 * explicitly promoted.
 */
export function isSandboxOnly(feature: string): boolean {
  const definition = FEATURE_FLAGS[feature];
  if (!definition) return false;
  return (
    definition.regulatorySensitive &&
    definition.enabledIn.includes("sandbox") &&
    !definition.enabledIn.includes("production")
  );
}

/**
 * Promote a feature from sandbox to production.  Returns a new flag map so
 * callers can persist or diff the result; the in-memory registry is updated
 * in place as well.  Throws if the feature is unknown.
 */
export function promoteFeatureToProduction(
  feature: string,
): Record<string, FeatureFlagDefinition> {
  const definition = FEATURE_FLAGS[feature];
  if (!definition) {
    throw new Error(`Unknown feature flag: ${feature}`);
  }
  if (!definition.enabledIn.includes("production")) {
    definition.enabledIn = [...definition.enabledIn, "production"];
  }
  return FEATURE_FLAGS;
}

/**
 * Demote a feature back to sandbox-only.  Useful for rolling back a promotion
 * that caused a compliance regression.
 */
export function demoteFeatureToSandbox(
  feature: string,
): Record<string, FeatureFlagDefinition> {
  const definition = FEATURE_FLAGS[feature];
  if (!definition) {
    throw new Error(`Unknown feature flag: ${feature}`);
  }
  definition.enabledIn = definition.enabledIn.filter(
    (env) => env !== "production",
  );
  return FEATURE_FLAGS;
}
