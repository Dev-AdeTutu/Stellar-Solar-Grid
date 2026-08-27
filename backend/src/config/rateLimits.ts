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
