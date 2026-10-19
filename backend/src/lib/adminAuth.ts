import { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * adminAuth — lightweight admin guard used on individual routes.
 *
 * Accepts authentication via:
 *   - Authorization: Bearer <ADMIN_API_KEY>
 *   - X-Admin-Key: <ADMIN_API_KEY>   (IoT bridge / header-only clients)
 *
 * Previously this silently called next() when ADMIN_API_KEY was unset,
 * creating a security gap in misconfigured deployments. Now it returns 503
 * in all environments so the misconfiguration is immediately visible.
 * ADMIN_API_KEY is also added to REQUIRED_ENV in index.ts for startup validation.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_API_KEY) {
    logger.error('ADMIN_API_KEY is not set — rejecting request (server misconfiguration)');
    return res.status(503).json({ error: 'Server misconfiguration', code: 'MISCONFIGURED' });
  }

  // Accept either Authorization: Bearer <key> or X-Admin-Key: <key>
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  const headerKey = req.headers['x-admin-key'] as string | undefined;

  if (bearerToken === ADMIN_API_KEY || headerKey === ADMIN_API_KEY) {
    return next();
  }

  logger.warn({ ip: req.ip, path: req.path, method: req.method }, 'Unauthorized admin request');
  return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
}
