import { Router } from "express";
import { register } from "../lib/metrics.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const metricsRouter = Router();

// 15-second in-memory cache so the admin dashboard never hammers prom-client
let cache: { data: object; expiresAt: number } | null = null;

/**
 * GET /api/metrics/summary
 *
 * Returns a JSON snapshot of the four core prom-client counters/gauges for
 * the admin dashboard overview.  Does not require Prometheus or Grafana.
 * Response is cached for 15 seconds.
 *
 * Closes #344.
 */
metricsRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    if (cache && Date.now() < cache.expiresAt) {
      return res.json(cache.data);
    }

    const metrics = await register.getMetricsAsJSON();

    const find = (name: string): number => {
      const metric = metrics.find((m: any) => m.name === name);
      return metric?.values?.[0]?.value ?? 0;
    };

    const data = {
      mqttMessages: find("solargrid_mqtt_messages_total"),
      contractCalls: find("solargrid_contract_invocations_total"),
      activeMeters: find("solargrid_active_meters"),
      paymentVolumeXlm: find("solargrid_payment_volume_xlm"),
    };

    cache = { data, expiresAt: Date.now() + 15_000 };
    res.json(data);
  }),
);
