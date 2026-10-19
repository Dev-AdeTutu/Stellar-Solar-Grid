/**
 * Simple integration check for CORS headers.
 * Run with: npm run test:cors (ensure backend is running on BACKEND_BASE or default http://localhost:3001)
 */
import assert from 'node:assert';

const BASE = process.env.BACKEND_BASE ?? 'http://localhost:3001';

async function req(path: string, method = 'GET') {
  const res = await fetch(BASE + path, { method });
  return res;
}

async function main() {
  // GET /health should include CORS header
  const h = await req('/health', 'GET');
  assert(h.headers.get('access-control-allow-origin'), '/health missing CORS header');

  // OPTIONS preflight for API route should return 204 and include CORS header
  const o = await req('/api/meters', 'OPTIONS');
  if (o.status !== 204 && o.status !== 200) throw new Error('OPTIONS did not return 204/200: ' + o.status);
  assert(o.headers.get('access-control-allow-origin'), 'OPTIONS missing CORS header');

  console.log('CORS integration checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
