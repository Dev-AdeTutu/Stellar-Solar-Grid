/**
 * Regression check for X-Forwarded-For spoofing against IP-based rate limiting.
 *
 * With TRUST_PROXY_HOPS at its safe default (0), Express ignores
 * X-Forwarded-For entirely and req.ip is always the real socket address, so
 * sending a different spoofed X-Forwarded-For on every request must NOT let
 * an attacker dodge the limiter.
 *
 * Run with: npm run test:rate-limit-spoof
 * (ensure backend is running on BACKEND_BASE or default http://localhost:3001,
 * with TRUST_PROXY_HOPS unset/0 and a low RATE_LIMIT_MAX for a fast run)
 */
import assert from 'node:assert';

const BASE = process.env.BACKEND_BASE ?? 'http://localhost:3001';
const REQUEST_COUNT = 100;

async function main() {
  let sawRateLimited = false;

  for (let i = 0; i < REQUEST_COUNT; i++) {
    const res = await fetch(BASE + '/api/health', {
      headers: {
        // A different forged client IP on every request — must not reset
        // or evade the limiter when trust proxy is at its safe default.
        'X-Forwarded-For': `10.0.0.${i % 255}`,
      },
    });

    if (res.status === 429) {
      sawRateLimited = true;
      break;
    }
  }

  assert(
    sawRateLimited,
    `Expected rate limiting to trigger within ${REQUEST_COUNT} requests despite spoofed X-Forwarded-For headers, but it never did`,
  );

  console.log('Rate limit X-Forwarded-For spoofing check passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
