
import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

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
  if (!provided || provided !== ADMIN_API_KEY) {
    logger.warn({ path: req.path, method: req.method }, 'Unauthorized admin request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
