/**
 * k6 load test for the backend's always-available critical endpoints.
 *
 * Scoped to /api/health and /metrics because they don't require a funded,
 * live Soroban contract to exercise meaningfully — payments/meters endpoints
 * do on-chain work and need real testnet credentials, so they aren't safe to
 * hammer from CI. This still catches regressions in the shared Express
 * middleware stack (helmet, CORS, rate limiting, logging, timeouts) that
 * every request pays for.
 *
 * Run locally:
 *   k6 run backend/loadtest/critical-endpoints.js
 *   BASE_URL=https://staging.example.com k6 run backend/loadtest/critical-endpoints.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

const healthDuration = new Trend('health_duration', true);
const metricsDuration = new Trend('metrics_duration', true);
const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    health: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      exec: 'checkHealth',
    },
    metrics: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      exec: 'checkMetrics',
    },
  },
  thresholds: {
    // Performance budgets — CI fails the build if these are exceeded.
    // /api/health calls out to Stellar RPC + MQTT so it gets a looser
    // budget than /metrics, which is pure in-process work.
    health_duration: ['p(95)<800', 'p(99)<1500'],
    metrics_duration: ['p(95)<150', 'p(99)<300'],
    errors: ['rate<0.01'],
  },
};

export function checkHealth() {
  const res = http.get(`${BASE_URL}/api/health`);
  healthDuration.add(res.timings.duration);
  const ok = check(res, {
    // 503 is a legitimate "dependency degraded" response, not a perf failure
    'health status is 200 or 503': (r) => r.status === 200 || r.status === 503,
  });
  errorRate.add(!ok);
  sleep(1);
}

export function checkMetrics() {
  const res = http.get(`${BASE_URL}/metrics`);
  metricsDuration.add(res.timings.duration);
  const ok = check(res, {
    'metrics status is 200': (r) => r.status === 200,
  });
  errorRate.add(!ok);
  sleep(1);
}
