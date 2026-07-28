import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { randomUUID } from 'crypto';

export default function requestLogger(req: Request, _res: Response, next: NextFunction) {
  (req as any).reqId = randomUUID();
  logger.info({ reqId: (req as any).reqId, method: req.method, path: req.path });
  next();
}
