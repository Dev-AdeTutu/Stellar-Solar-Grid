import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { randomUUID } from 'crypto';
import { requestContext } from '../lib/requestContext.js';

export default function requestLogger(req: Request, res: Response, next: NextFunction) {
  const reqId = (req.headers['x-request-id'] as string) || (req as any).reqId || randomUUID();
  (req as any).reqId = reqId;
  res.setHeader('X-Request-ID', reqId);
  
  logger.info({ reqId, method: req.method, path: req.path });
  
  requestContext.run({ reqId }, () => {
    next();
  });
}
