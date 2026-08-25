import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { logger } from '../lib/logger.js';
import { auditLog, buildAuditEntry } from '../lib/audit.js';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * #530 — Dedicated rate-limiter scoped exclusively to *failed* admin-auth
 * attempts.  Intentionally separate from the general writeLimiter so that
 * brute-force probing of X-Admin-Key cannot hide inside the shared write
 * budget and cannot be exhausted by legitimate write traffic.
 *
 * Window / max are independently configurable via env vars so operators can
 * tune them without touching the write-limiter knobs.
 */
const ADMIN_FAIL_WINDOW_MS = Number(process.env.ADMIN_FAIL_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000); // 15 min
const ADMIN_FAIL_MAX = Number(process.env.ADMIN_FAIL_RATE_LIMIT_MAX ?? 10);

export const adminFailureLimiter = rateLimit({
  windowMs: ADMIN_FAIL_WINDOW_MS,
  max: ADMIN_FAIL_MAX,
  skipSuccessfulRequests: false, // we gate it manually below — see requireAdminKey
  standardHeaders: true,
  legacyHeaders: false,
  // Key by IP so each client gets its own bucket
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler: (_req, res) => {
    res.setHeader('Retry-After', String(Math.ceil(ADMIN_FAIL_WINDOW_MS / 1000)));
    logger.warn('Admin auth failure rate limit exceeded — possible brute-force attempt');
    res.status(429).json({
      error: 'Too many failed admin auth attempts. Try again later.',
      code: 'ADMIN_AUTH_RATE_LIMITED',
    });
  },
  // Only count requests that actually reach this limiter (failures); successful
  // requests bypass it entirely — see the early-return in requireAdminKey below.
  skip: () => false,
});

function hasValidSessionToken(req: Request): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ') || !ADMIN_API_KEY) return false;
  const jwtSecret = process.env.JWT_SECRET ?? ADMIN_API_KEY;
  try {
    // Issue #598: expiration must always be enforced here. `ignoreExpiration`
    // is explicitly set to `false` (rather than just omitted) so a future
    // edit can't silently disable exp-claim validation, and `algorithms` is
    // pinned to the one algorithm we sign with to prevent algorithm-confusion
    // attacks. jwt.verify throws (caught below, returns false) for an
    // expired, malformed, or wrong-signature token.
    const payload = jwt.verify(auth.slice(7), jwtSecret, {
      algorithms: ['HS256'],
      ignoreExpiration: false,
    });
    return typeof payload === 'object' && payload.role === 'admin';
  } catch {
    return false;
  }
}

/**
 * requireAdminKey — verifies the request carries a valid admin credential.
 *
 * On *success* the request proceeds immediately; the failure limiter is never
 * consulted so legitimate traffic can never exhaust the lockout budget.
 *
 * On *failure* the dedicated adminFailureLimiter is invoked first.  Once the
 * caller has burned through ADMIN_FAIL_MAX bad attempts within the window,
 * subsequent requests receive 429 until the window resets.
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('ADMIN_API_KEY not set in production');
      return res.status(503).json({ error: 'Server misconfiguration' });
    }
    logger.warn('ADMIN_API_KEY not set — skipping auth check (dev mode)');
    // Still audit dev-mode admin calls so the log trail is complete
    auditLog(buildAuditEntry(req));
    return next();
  }

  const provided = req.headers['x-admin-key'];
  if (provided === ADMIN_API_KEY || hasValidSessionToken(req)) {
    // Successful auth — skip the failure limiter entirely
    return next();
  }

  // Auth passed — emit structured audit entry before continuing
  auditLog(buildAuditEntry(req));
  next();
}
