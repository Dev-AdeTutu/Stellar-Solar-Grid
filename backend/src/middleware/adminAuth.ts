
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function hasValidSessionToken(req: Request): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ') || !ADMIN_API_KEY) return false;
  const jwtSecret = process.env.JWT_SECRET ?? ADMIN_API_KEY;
  try {
    const payload = jwt.verify(auth.slice(7), jwtSecret);
    return typeof payload === 'object' && payload.role === 'admin';
  } catch {
    return false;
  }
}

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('ADMIN_API_KEY not set in production');
      return res.status(503).json({ error: 'Server misconfiguration' });
    }
    logger.warn('ADMIN_API_KEY not set — skipping auth check (dev mode)');
    return next();
  }
  const provided = req.headers['x-admin-key'];
  if (provided === ADMIN_API_KEY || hasValidSessionToken(req)) {
    return next();
  }
  logger.warn({ path: req.path, method: req.method }, 'Unauthorized admin request');
  return res.status(401).json({ error: 'Unauthorized' });
}
