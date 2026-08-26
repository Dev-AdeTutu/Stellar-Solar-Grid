import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import timeout from "connect-timeout";
import { NextFunction, Request, Response } from "express";
import mqtt from "mqtt";
import { stellarService, server } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { startIoTBridge } from "./iot/bridge.js";
import { logger } from "./lib/logger.js";
import { runWithRequestId } from "./lib/requestContext.js";
import {
  initUsageEventStore,
  startUsageEventRetryWorker,
} from "./lib/usageEvents.js";

// Environment variable validation
const REQUIRED_ENV = [
  'ADMIN_SECRET_KEY',
  'CONTRACT_ID',
  'STELLAR_RPC_URL',
  'MQTT_BROKER',
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('Missing required environment variables:', missing.join(', '));
  console.error('Copy backend/.env.example to backend/.env and fill in the values.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT ?? 3001;

// Capture raw body for webhook signature verification before JSON parsing
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Request timeout — configurable via REQUEST_TIMEOUT env var (default 15s)
const requestTimeout = process.env.REQUEST_TIMEOUT ?? '15s';
app.use(timeout(requestTimeout));

// Halt middleware chain if request has already timed out
app.use((req: any, _res: any, next: any) => {
  if (!req.timedout) next();
});

// Assign/propagate a request id so every log line for a request can be
// correlated, and callers can trace a request via the response header.
app.use((req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string | undefined) || randomUUID();
  res.setHeader("X-Request-Id", requestId);
  runWithRequestId(requestId, next);
});

app.use((req, _res, next) => {
  logger.info("Incoming request", { method: req.method, path: req.path });
  next();
});

// ── API versioning ──────────────────────────────────────────────────────────
// /api/v1/* is the versioned, stable surface. /api/* remains an alias to the
// latest version (v1 today) so existing clients keep working. When a v2 ships
// with breaking changes, mount it separately and point the /api/* alias at
// it, while /api/v1/* keeps serving old clients until its documented sunset
// date (see docs/API_VERSIONING.md).
const v1Router = express.Router();
v1Router.use("/meters", createMeterRouter(stellarService));
v1Router.use("/payments", paymentsRouter);
v1Router.use("/webhooks", webhookRouter);

app.use("/api/v1", v1Router);
app.use("/api", v1Router);

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = {};

  // Check Stellar RPC
  try {
    await server.getLatestLedger();
    checks.stellar = 'ok';
  } catch (err) {
    logger.error('Stellar health check failed', { err });
    checks.stellar = 'error';
  }

  // Check MQTT by attempting a short-lived connection
  const broker = process.env.MQTT_BROKER ?? 'mqtt://localhost:1883';
  try {
    const client = mqtt.connect(broker, { reconnectPeriod: 0, connectTimeout: 3000 });
    const ok = await new Promise<boolean>((resolve) => {
      const onConnect = () => {
        client.end(true);
        resolve(true);
      };
      const onError = () => {
        client.end(true);
        resolve(false);
      };
      const timer = setTimeout(() => {
        client.end(true);
        resolve(false);
      }, 3000);

      client.once('connect', () => { clearTimeout(timer); onConnect(); });
      client.once('error', () => { clearTimeout(timer); onError(); });
    });
    checks.mqtt = ok ? 'ok' : 'error';
  } catch (err) {
    logger.error('MQTT health check failed', { err });
    checks.mqtt = 'error';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Timeout error handler — must come before the generic error handler
app.use((err: any, req: any, res: any, next: any) => {
  if (req.timedout) {
    logger.error('Request timed out', {
      method: req.method,
      path: req.path,
      timeout: requestTimeout,
    });
    return res.status(504).json({ error: 'Request timed out' });
  }
  next(err);
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Request error", { error: err.message });

  const parseError = err as Error & {
    type?: string;
    status?: number;
    body?: unknown;
  };
  if (
    parseError.type === "entity.parse.failed" ||
    (err instanceof SyntaxError && typeof parseError.body !== "undefined") ||
    parseError.status === 400
  ) {
    return res.status(400).json({ error: "Invalid JSON request body" });
  }

  return res
    .status(500)
    .json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  initUsageEventStore();
  startUsageEventRetryWorker();
  logger.info("SolarGrid backend listening", { port: PORT });
  startIoTBridge();
});
