import "dotenv/config";
import { createRequire } from "module";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import timeout from "connect-timeout";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import rateLimit from "express-rate-limit";
import { createRequire } from "module";

import { stellarService, server } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { statsRouter } from "./routes/stats.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { metricsRouter } from "./routes/metrics.js";
import { providerRouter } from "./routes/provider.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { pushSubscriptionsRouter } from "./routes/pushSubscriptions.js";
import { providerRouter } from "./routes/provider.js";
import { solarRouter } from "./routes/solar.js";
import { usageEventsRouter } from "./routes/usageEvents.js";
import { startIoTBridge } from "./iot/bridge.js";
import { logger } from "./lib/logger.js";
import { register } from "./lib/metrics.js";
import { writeLimiter, paymentsLimiter } from "./middleware/rateLimit.js";
import { payerRateLimiter } from "./middleware/payerRateLimit.js";
import { sanitiseBody } from "./middleware/sanitise.js";
import requestLoggerMiddleware from "./middleware/requestLogger.js";
import {
  initUsageEventStore,
  startUsageEventRetryWorker,
  countDeadLetterEvents,
} from "./lib/usageEvents.js";
import { initMeterNotesStore } from "./lib/meterNotes.js";
import { getReqId } from "./lib/requestContext.js";

// ── Rate-limit config ────────────────────────────────────────────────────────
// Closes #539: all env-var parsing lives in config/rateLimits.ts; this file
// imports the parsed values so there is a single source of truth shared with
// middleware/rateLimit.ts.
import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  PAYMENTS_RATE_LIMIT_MAX,
  RATE_LIMIT_MESSAGE,
} from "./config/rateLimits.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────
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

const app = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }),
);

// #599: gzip/brotli-compress responses over 1 KB.
app.use(compression({ threshold: 1024 }));

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        allowedOrigins.includes("*") ||
        allowedOrigins.includes(origin)
      ) {
        cb(null, true);
      } else {
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
    optionsSuccessStatus: 204,
    credentials: true,
  }),
);

// ── Body parsing ─────────────────────────────────────────────────────────────
// Capture raw body for webhook signature verification before JSON parsing.
// #423: apply body size limit.
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

// ── Request timeout ──────────────────────────────────────────────────────────
// Configurable via REQUEST_TIMEOUT env var (default 15 s).
const requestTimeout = process.env.REQUEST_TIMEOUT ?? "15s";
app.use(timeout(requestTimeout));
app.use((req: any, _res: any, next: any) => {
  if (!req.timedout) next();
});

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Env-var parsing is centralised in config/rateLimits.ts (closes #539).

// Global read limiter — scoped to /api, one counter per IP (#504).
const globalReadLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    );
    res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: "RATE_LIMITED" });
  },
});

// Payments-specific limiter — stricter than the general write limiter because
// each payment hits the Stellar network and costs gas.
const paymentsLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: PAYMENTS_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    );
    res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: "RATE_LIMITED" });
  },
});

// Apply global read limiter to all /api routes.
app.use("/api", globalReadLimiter);

// ── Prometheus metrics endpoint ───────────────────────────────────────────────
//
// INTENTIONALLY PUBLIC — no authentication required.
//
// Design rationale (closes #537):
//   Prometheus's scrape model requires unauthenticated HTTP GET access to the
//   /metrics path.  In this deployment the backend port (3001) is exposed only
//   on the internal Docker network (app-network) and is not forwarded to a
//   public interface.  The Prometheus container scrapes it from within that
//   private network (see infra/prometheus.yml).
//
//   If the backend is ever exposed on a public-facing port, access to /metrics
//   should be restricted at the reverse-proxy layer (e.g. an nginx `location
//   /metrics { deny all; }` block or a firewall rule that allows only the
//   Prometheus container's IP).  An IP-allowlist middleware can also be added
//   here using the METRICS_ALLOWED_CIDRS env var in a future hardening pass.
//
//   The endpoint is registered *before* the /api rate-limiter so Prometheus
//   scrapes are never throttled by the per-IP write budget.
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ── Routes ───────────────────────────────────────────────────────────────────

// Swagger / OpenAPI docs
try {
  const openApiDocument = YAML.load("./openapi.yaml");
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
} catch {
  logger.warn("openapi.yaml not found; /api/docs will not be available");
}

app.use("/api/admin/login", writeLimiter, adminLoginRouter);
// Body parsing above makes payer/owner available before this limiter runs.
// Missing payer identities remain governed by the global IP limiter.
app.use("/api/meters", payerRateLimiter, createMeterRouter(stellarService));
app.use("/api/payments", payerRateLimiter, writeLimiter, paymentsRouter);
app.use("/api/webhooks", writeLimiter, webhookRouter);
app.use("/api/allowlist", writeLimiter, allowlistRouter);
app.use("/api/collaborators", collaboratorRouter);
app.use("/api/sms-config", smsConfigRouter);
app.use("/api/client-errors", writeLimiter, clientErrorsRouter);
app.use("/api/push", writeLimiter, pushSubscriptionsRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/solar", solarRouter);
app.use("/api/usage-events", usageEventsRouter);
app.use("/api/provider", providerRouter);
app.use("/api/usage-events", usageEventsRouter);

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};

  let rpcOk = false;
  try {
    await server.getLatestLedger();
    checks.stellar = "ok";
  } catch (err) {
    logger.error("Stellar health check failed", { err });
    checks.stellar = "error";
  }

  let mqttOk = false;
  try {
    const client = mqtt.connect(broker, { reconnectPeriod: 0, connectTimeout: 3000 });
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { client.end(true); resolve(false); }, 3000);
      client.once("connect", () => { clearTimeout(timer); client.end(true); resolve(true); });
      client.once("error", () => { clearTimeout(timer); client.end(true); resolve(false); });
    });
    checks.mqtt = ok ? "ok" : "error";
  } catch (err) {
    logger.error("MQTT health check failed", { err });
    checks.mqtt = "error";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks,
    deadLetterEvents: countDeadLetterEvents(),
  });
});

// #418: 404 catch-all — must come after all routes.
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Route not found",
    code: "NOT_FOUND",
    hint: "Check /api/docs for available endpoints",
    requestId: getReqId(),
  });
});

// ── Error handlers ───────────────────────────────────────────────────────────

// Timeout error handler.
app.use((err: any, req: any, res: any, next: any) => {
  if (req.timedout) {
    logger.error("Request timed out", { method: req.method, path: req.path });
    return res
      .status(504)
      .json({ error: "Request timed out", code: "TIMEOUT", requestId: getReqId() });
  }

// #423: 413 payload too large handler + global error handler (#418).
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, "Unhandled error");

  if (err.type === "entity.too.large") {
    return res
      .status(413)
      .json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE", requestId });
  }
  if (
    err.type === "entity.parse.failed" ||
    (err instanceof SyntaxError && (err as any).body !== undefined)
  ) {
    return res
      .status(400)
      .json({ error: "Invalid JSON body", code: "INVALID_JSON", requestId });
  }
  if ((err as any).status === 404) {
    return res
      .status(404)
      .json({ error: "Resource not found", code: "NOT_FOUND", requestId });
  }
  if ((err as any).code === "VALIDATION_ERROR" && (err as any).details) {
    return res.status(400).json({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: (err as any).details,
      requestId,
    });
  }
  res
    .status(500)
    .json({ error: err.message || "Internal server error", code: "INTERNAL_ERROR", requestId });
});

// ── Server startup ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT, network: process.env.STELLAR_NETWORK ?? "testnet" }, "SolarGrid backend started");
  initUsageEventStore();
  initMeterNotesStore();
  startUsageEventRetryWorker();
  startLimitWatcher(stellarService);
  try {
    startIoTBridge();
  } catch (err) {
    logger.error("Failed to start IoT bridge", { err });
  }
});
