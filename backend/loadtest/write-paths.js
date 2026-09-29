/**
 * k6 load test for write paths: meter registration, payments, usage updates (#840).
 *
 * SCENARIO selects the concurrency tier: 100 | 500 | 1000 virtual users.
 *   k6 run -e SCENARIO=100  backend/loadtest/write-paths.js
 *   k6 run -e SCENARIO=1000 -e BASE_URL=https://staging.example.com backend/loadtest/write-paths.js
 *
 * Without a funded contract the endpoints may answer 4xx (validation / auth /
 * on-chain rejection); that is still a handled response. Only 5xx, timeouts
 * and connection failures count as errors.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const VUS = parseInt(__ENV.SCENARIO || '100', 10);

const registerDuration = new Trend('register_duration', true);
const paymentDuration = new Trend('payment_duration', true);
const usageDuration = new Trend('usage_duration', true);
const errorRate = new Rate('errors');
const requests = new Counter('requests_total');

const ramp = (exec) => ({
  executor: 'ramping-vus',
  startVUs: 0,
  stages: [
    { duration: '30s', target: Math.ceil(VUS / 3) },
    { duration: '1m', target: Math.ceil(VUS / 3) },
    { duration: '15s', target: 0 },
  ],
  exec,
});

export const options = {
  scenarios: {
    register: ramp('registerMeter'),
    payments: ramp('makePayment'),
    usage: ramp('updateUsage'),
  },
  thresholds: {
    register_duration: ['p(95)<1500'],
    payment_duration: ['p(95)<1500'],
    usage_duration: ['p(95)<500'],
    errors: ['rate<0.01'],
    http_reqs: ['rate>10'],
  },
};

const headers = { 'Content-Type': 'application/json' };
const meterId = () => `LOAD-${__VU}-${__ITER}`;

function record(res, trend) {
  trend.add(res.timings.duration);
  requests.add(1);
  const ok = check(res, { 'no server error': (r) => r.status > 0 && r.status < 500 });
  errorRate.add(!ok);
  sleep(1);
}

export function registerMeter() {
  const res = http.post(`${BASE_URL}/api/meters`, JSON.stringify({ meter_id: meterId(), owner: __ENV.OWNER || 'GLOADTEST' }), { headers });
  record(res, registerDuration);
}

export function makePayment() {
  const res = http.post(`${BASE_URL}/api/payments`, JSON.stringify({ meter_id: meterId(), amount: 1_000_000, plan: 'Daily' }), { headers });
  record(res, paymentDuration);
}

export function updateUsage() {
  const res = http.post(`${BASE_URL}/api/usage`, JSON.stringify({ meter_id: meterId(), units: 10, cost: 100 }), { headers });
  record(res, usageDuration);
}
