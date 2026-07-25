import "dotenv/config";
import express from "express";
import timeout from "connect-timeout";
import { NextFunction, Request, Response } from "express";
import mqtt from "mqtt";
import { stellarService, server } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { statsRouter } from "./routes/stats.js";
import { startIoTBridge } from "./iot/bridge.js";
import { logger } from "./lib/logger.js";
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

app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path });
  next();
});

app.use("/api/meters", createMeterRouter(stellarService));
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhookRouter);
app.use("/api/stats", statsRouter);

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
