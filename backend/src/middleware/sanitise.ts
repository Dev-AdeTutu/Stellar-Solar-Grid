import { Request, Response, NextFunction } from 'express';

function deepSanitise(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  const safe: Record<string, any> = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    safe[key] = deepSanitise(obj[key]);
  }
  return safe;
}

export function sanitiseBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitise(req.body);
  }
  next();
}
