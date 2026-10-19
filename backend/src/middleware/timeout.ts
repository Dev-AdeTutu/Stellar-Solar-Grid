import rateLimit from 'express-rate-limit';

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const max = parseInt(process.env.RATE_LIMIT_MAX ?? '30', 10);

export const writeLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMITED' },
});

export const readLimiter = rateLimit({
  windowMs,
  max: max * 4,
  standardHeaders: true,
  legacyHeaders: false,
});
