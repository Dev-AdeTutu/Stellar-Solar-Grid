import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import compression from "compression";
import timeout from "connect-timeout";
import mqtt from "mqtt";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { stellarService, server } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { statsRouter } from "./routes/stats.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { statsRouter as duplicateStatsRouter } from "./routes/stats.js";
import { metricsRouter } from "./routes/metrics.js";
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { providerRouter } from "./routes/provider.js";
import { solarRouter } from "./routes/solar.js";
import { usageEventsRouter } from "./routes/usageEvents.js";
import { startIoTBridge } from "./iot/bridge.js";
import { startLimitWatcher } from "./iot/limitWatcher.js";
import { logger } from "./lib/logger.js";
import { register } from "./lib/metrics.js";
import { writeLimiter } from "./middleware/rateLimit.js";
import { sanitiseBody } from "./middleware/sanitise.js";
import requestLoggerMiddleware from "./middleware/requestLogger.js";
import rateLimit from "express-rate-limit";
import {
  initUsageEventStore,
  startUsageEventRetryWorker,
} from "./lib/usageEvents.js";
import { getReqId } from "./lib/requestContext.js";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const { version } = _require("../../package.json") as { version: string };

const REQUIRED_ENV = ["CONTRACT_ID", "ADMIN_SECRET_KEY", "ADMIN_API_KEY", "STELLAR_RPC_URL", "MQTT_BROKER"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  logger.fatal(
    { missing },
    "Missing required environment variables. Copy backend/.env.example to backend/.env."
  );
  process.exit(1);
}

const PORT = process.env.PORT ?? 3001;
// #423: configurable body size limit
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT ?? "100kb";

const app = express();
const startTime = Date.now();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// #599: gzip/brotli-compress responses over 1 KB (e.g. large meter-list
// payloads). `compression` negotiates the best encoding the client
// advertises via Accept-Encoding (br when supported, else gzip/deflate)
// and leaves small responses untouched below the threshold.
app.use(compression({ threshold: 1024 }));

const allowedOrigins = (process.env.CORS_ORIGIN ?? '*').split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
  optionsSuccessStatus: 204,
  credentials: true,
}));

// Capture raw body for webhook signature verification before JSON parsing
// Capture raw body for webhook signature verification before JSON parsing.
// #423: apply body size limit
app.use(
  express.json({
    limit: BODY_LIMIT,
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

app.use(sanitiseBody);
app.use(requestLoggerMiddleware);

// Request timeout — configurable via REQUEST_TIMEOUT env var (default 15s)
const requestTimeout = process.env.REQUEST_TIMEOUT ?? "15s";
app.use(timeout(requestTimeout));

app.use((req: any, _res: any, next: any) => {
  if (!req.timedout) next();
});

// Rate limiting configuration (driven by env vars)
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);
const PAYMENTS_RATE_LIMIT_MAX = Number(process.env.PAYMENTS_RATE_LIMIT_MAX ?? 10);
const RATE_LIMIT_MESSAGE = process.env.RATE_LIMIT_MESSAGE ?? 'Too many requests, please try again later.';

// Single global read limiter — scoped to /api, one counter per class (#504)
const globalReadLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    // Provide Retry-After in seconds
    res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// Payments-specific write limiter — stricter than the general write limiter
const paymentsLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: PAYMENTS_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  },
});

// Apply global read limiter to all /api routes
app.use('/api', globalReadLimiter);

app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path });
  next();
});

// ── Routes ──────────────────────────────────────────────────────────────────────────────

app.use("/api/admin/login", writeLimiter, adminLoginRouter);
app.use("/api/meters", createMeterRouter(stellarService));
app.use("/api/payments", paymentsLimiter, paymentsRouter);
app.use("/api/webhooks", writeLimiter, webhookRouter);
app.use("/api/allowlist", writeLimiter, allowlistRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhookRouter);
app.use("/api/stats", statsRouter);

app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = {};
});
app.use("/api/collaborators", collaboratorRouter);
app.use("/api/allowlist", allowlistRouter);
app.use("/api/collaborators", collaboratorRouter);
app.use("/api/stats", statsRouter);
app.use("/api/sms-config", smsConfigRouter);
app.use("/api/client-errors", writeLimiter, clientErrorsRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/solar", solarRouter);
app.use("/api/usage-events", usageEventsRouter);

// #420: GET /api/health — version, uptime, dependency status
app.get("/api/health", async (_req, res) => {
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);

  // Check Stellar RPC
  let rpcOk = false;
  try {
    await server.getLatestLedger();
    rpcOk = true;
  } catch {
    logger.warn("Stellar RPC health check failed");
  }

  // Check MQTT
  let mqttOk = false;
  try {
    const { getMqttClient } = await import("./iot/bridge.js");
    const client = getMqttClient();
    mqttOk = client?.connected ?? false;
  } catch {
    logger.warn("MQTT health check failed");
  }

  const healthy = rpcOk && mqttOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    version,
    uptimeSec,
    dependencies: {
      stellarRpc: rpcOk ? "ok" : "unreachable",
      mqtt: mqttOk ? "ok" : "unreachable",
    },
  });
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// #418: 404 catch-all — must come after all routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Route not found",
    code: "NOT_FOUND",
    hint: "Check /api/docs for available endpoints",
    requestId: getReqId(),
  });
});

// Timeout error handler
app.use((err: any, req: any, res: any, next: any) => {
  if (req.timedout) {
    logger.error("Request timed out", { method: req.method, path: req.path });
    return res.status(504).json({ error: "Request timed out", code: "TIMEOUT", requestId: getReqId() });
  }
  next(err);
});

// #423: 413 payload too large handler + global error handler (#418)
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, "Unhandled error");
  const requestId = getReqId();

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE", requestId });
  }
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && (err as any).body !== undefined)) {
    return res.status(400).json({ error: "Invalid JSON body", code: "INVALID_JSON", requestId });
  }
  if ((err as any).status === 404) {
    return res.status(404).json({ error: "Resource not found", code: "NOT_FOUND", requestId });
  }
  if ((err as any).code === "VALIDATION_ERROR" && (err as any).details) {
    return res.status(400).json({ error: "Validation failed", code: "VALIDATION_ERROR", details: (err as any).details, requestId });
  }
  res.status(500).json({ error: err.message || "Internal server error", code: "INTERNAL_ERROR", requestId });
});

app.listen(PORT, () => {
  logger.info({ port: PORT, network: process.env.STELLAR_NETWORK ?? "testnet" }, "SolarGrid backend started");
  initUsageEventStore();
  startUsageEventRetryWorker();
  logger.info("SolarGrid backend listening", { port: PORT });
  startLimitWatcher(stellarService);
  try {
    startIoTBridge();
  } catch (err) {
    logger.error("Failed to start IoT bridge", { err });
  }
});
