import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../lib/logger.js';

export const adminLoginRouter = Router();

adminLoginRouter.post('/', (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    logger.error('ADMIN_SECRET env var not set');
    return res.status(503).json({ error: 'Server misconfiguration' });
  }

  const { secret } = req.body as { secret?: string };
  if (!secret || secret !== adminSecret) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }

  const jwtSecret = process.env.JWT_SECRET ?? adminSecret;
  const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '8h' });
  return res.json({ token });
});
