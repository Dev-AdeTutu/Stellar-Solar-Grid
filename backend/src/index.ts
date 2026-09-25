import "dotenv/config";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createRequire } from "module";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import mqtt from "mqtt";
import { statSync } from "node:fs";
import timeout from "connect-timeout";
import helmet from "helmet";
import compression from "compression";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import rateLimit from "express-rate-limit";
import * as OpenApiValidator from "express-openapi-validator";

import { stellarService, server } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { receiptsRouter } from "./routes/receipts.js";
import { createMeterQrRouter } from "./routes/meterQr.js";
import { webhookRouter } from "./routes/webhooks.js";
import { statsRouter } from "./routes/stats.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { metricsRouter } from "./routes/metrics.js";
import { providerRouter } from "./routes/provider.js";
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { pushSubscriptionsRouter } from "./routes/pushSubscriptions.js";
import { solarRouter } from "./routes/solar.js";
import { usageEventsRouter } from "./routes/usageEvents.js";
import { analyticsRouter } from "./routes/analytics.js";
import { insightsRouter } from "./routes/insights.js";
import { graphqlRouter } from "./routes/graphql.js";
import { usageRouter } from "./routes/usage.js";
import { meterMapRouter } from "./routes/meterMap.js";
import { delegatesRouter } from "./routes/delegates.js";
import { startIoTBridge, stopIoTBridge } from "./iot/bridge.js";
import { startLimitWatcher } from "./iot/limitWatcher.js";
import { logger } from "./lib/logger.js";
import { runWithRequestId } from "./lib/requestContext.js";
import { requestLogger } from "./lib/requestLogger.js";
import { register, updateSqlitePoolMetrics } from "./lib/metrics.js";
import { writeLimiter, paymentsLimiter } from "./middleware/rateLimit.js";
import { payerRateLimiter } from "./middleware/payerRateLimit.js";
import { sanitiseBody } from "./middleware/sanitise.js";
import { validateContentType } from "./middleware/validateContentType.js";
import requestLoggerMiddleware from "./middleware/requestLogger.js";
import { tracingMiddleware } from "./middleware/tracing.js";
import { shutdownTracing } from "./lib/tracing.js";
import { getCircuitState } from "./lib/circuitBreaker.js";
import {
  countDeadLetterEvents,
  getUsageEventPoolStatus,
  initUsageEventStore,
  startUsageEventRetryWorker,
  startUsageCompactionWorker,
} from "./lib/usageEvents.js";
import { initMeterNotesStore, getMeterNotesPoolStatus } from "./lib/meterNotes.js";
import { getUsageHistoryPoolStatus } from "./lib/usageHistory.js";
import { closeAllDatabases } from "./lib/databaseLifecycle.js";
import { getReqId } from "./lib/requestContext.js";
// Issue #696: Import idempotency cleanup for graceful shutdown
import { _stopEvictionTimer } from "./middleware/idempotency.js";
import { buildHealthResponse } from "./lib/health.js";
import { isCorsOriginAllowed, parseCorsOrigins } from "./config/cors.js";

// â”€â”€ Rate-limit config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Closes #539: all env-var parsing lives in config/rateLimits.ts; this file
// imports the parsed values so there is a single source of truth shared with
// middleware/rateLimit.ts.
import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  PAYMENTS_RATE_LIMIT_MAX,
  RATE_LIMIT_MESSAGE,
} from "./config/rateLimits.js";

// â”€â”€ Bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _require = createRequire(import.meta.url);
const { version } = _require("../../package.json") as { version: string };

const REQUIRED_ENV = [
  "CONTRACT_ID",
  "ADMIN_SECRET_KEY",
  "ADMIN_API_KEY",
  "MQTT_BROKER",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (!process.env.STELLAR_RPC_URL && !process.env.STELLAR_RPC_URLS) {
  missing.push("STELLAR_RPC_URL (or STELLAR_RPC_URLS)");
}
if (missing.length > 0) {
  logger.fatal(
    { missing },
    "Missing required environment variables. Copy backend/.env.example to backend/.env.",
  );
  process.exit(1);
}

const PORT = process.env.PORT ?? 3001;
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT ?? "100kb";
const STARTED_AT = Date.now();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface MeterFirmware {
  meterId: string;
  firmwareVersion: string;
  reportedAt: string;
}

const firmwareByMeter = new Map<string, MeterFirmware>();

const LATEST_FIRMWARE_VERSION = process.env.LATEST_FIRMWARE_VERSION || '1.0.0';

function isOutdated(version: string): boolean {
  return version !== LATEST_FIRMWARE_VERSION;
}

app.use("/api/admin", writeLimiter, adminLoginRouter);
app.use("/api/meters/map", meterMapRouter);
// Body parsing above makes payer/owner available before this limiter runs.
// Missing payer identities remain governed by the global IP limiter.
app.use("/api/meters", payerRateLimiter, createMeterRouter(stellarService));
app.use("/api/payments", payerRateLimiter, writeLimiter, paymentsRouter);
app.use("/api/delegates", writeLimiter, delegatesRouter);
app.use("/api/webhooks", writeLimiter, webhookRouter);
app.use("/api/allowlist", writeLimiter, allowlistRouter);
app.use("/api/collaborators", collaboratorRouter);
app.use("/api/sms-config", smsConfigRouter);
app.use("/api/client-errors", writeLimiter, clientErrorsRouter);
app.use("/api/push", writeLimiter, pushSubscriptionsRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/solar", solarRouter);
app.use("/api/usage-events", usageEventsRouter);
app.use("/api/usage", usageRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/meters", insightsRouter);
app.use("/api/graphql", graphqlRouter);
app.use("/graphql", graphqlRouter);
app.use("/api/provider", providerRouter);

// â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const mqttUrl = process.env.MQTT_URL || 'mqtt://localhost:1883';
const mqttClient = mqtt.connect(mqttUrl);

mqttClient.on('connect', () => {
  mqttClient.subscribe('meters/+/telemetry');
});

mqttClient.on('message', (topic: string, payload: Buffer) => {
  try {
    const data = JSON.parse(payload.toString());
    const parts = topic.split('/');
    const meterId = data.meterId || parts[1];
    if (!meterId) {
      return;
    }
    if (typeof data.firmware_version === 'string' && data.firmware_version.length > 0) {
      const record = recordFirmware(meterId, data.firmware_version);
      if (isOutdated(record.firmwareVersion)) {
        console.warn(
          `Meter ${meterId} is running outdated firmware ${record.firmwareVersion} (latest ${LATEST_FIRMWARE_VERSION})`
        );
      }
    }
  } catch (err) {
    console.error('Failed to parse MQTT payload', err);
  }
});

app.get('/api/meters/firmware-report', (_req: Request, res: Response) => {
  const report = Array.from(firmwareByMeter.values()).map((record) => ({
    ...record,
    outdated: isOutdated(record.firmwareVersion),
  }));
  res.json({
    latestFirmwareVersion: LATEST_FIRMWARE_VERSION,
    meters: report,
  });
});

app.get('/api/meters/:meterId/firmware', (req: Request, res: Response) => {
  const record = firmwareByMeter.get(req.params.meterId);
  if (!record) {
    return res.status(404).json({ error: 'No firmware version recorded for meter' });
  }
  res.json({
    ...record,
    outdated: isOutdated(record.firmwareVersion),
    latestFirmwareVersion: LATEST_FIRMWARE_VERSION,
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});

export { app, pool, recordFirmware, isOutdated, firmwareByMeter };
