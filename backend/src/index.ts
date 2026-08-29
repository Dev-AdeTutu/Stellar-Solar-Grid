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
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import { schema, rootValue } from "./routes/graphql.js";
import { parse } from "graphql";

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
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { pushSubscriptionsRouter } from "./routes/pushSubscriptions.js";
import { solarRouter } from "./routes/solar.js";
import { usageEventsRouter } from "./routes/usageEvents.js";
import { analyticsRouter } from "./routes/analytics.js";
import { graphqlRouter } from "./routes/graphql.js";
import { delegatesRouter } from "./routes/delegates.js";
import { startIoTBridge } from "./iot/bridge.js";
import { startLimitWatcher } from "./iot/limitWatcher.js";
import { logger } from "./lib/logger.js";
import { runWithRequestId } from "./lib/requestContext.js";
import { requestLogger } from "./lib/requestLogger.js";
import { register } from "./lib/metrics.js";
import { writeLimiter, paymentsLimiter } from "./middleware/rateLimit.js";
import { payerRateLimiter } from "./middleware/payerRateLimit.js";
import { sanitiseBody } from "./middleware/sanitise.js";
import requestLoggerMiddleware from "./middleware/requestLogger.js";
import {
  countDeadLetterEvents,
  initUsageEventStore,
  startUsageEventRetryWorker,
} from "./lib/usageEvents.js";
import { closeAllDatabases } from "./lib/databaseLifecycle.js";
import { initMeterNotesStore } from "./lib/meterNotes.js";
import { getReqId } from "./lib/requestContext.js";
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

// â”€â”€ Security headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ CORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const allowedOrigins = (process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((o) => o.trim());
// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = parseCorsOrigins(process.env.CORS_ORIGINS);

app.use(
  cors({
    origin: (origin, cb) => {
      if (isCorsOriginAllowed(origin, allowedOrigins)) {
        cb(null, true);
      } else {
        cb(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
    optionsSuccessStatus: 204,
    maxAge: 86400,
    preflightContinue: false,
    credentials: true,
  }),
);

// â”€â”€ Body parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Request timeout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Configurable via REQUEST_TIMEOUT env var (default 15 s).
const requestTimeout = process.env.REQUEST_TIMEOUT ?? "15s";
app.use(timeout(requestTimeout));
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
app.use(requestLogger());
// â”€â”€ Rate limiters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Env-var parsing is centralised in config/rateLimits.ts (closes #539).

// Global read limiter â€” scoped to /api, one counter per IP (#504).
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

// Apply global read limiter to all /api routes.
app.use("/api", globalReadLimiter);

// â”€â”€ Prometheus metrics endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// INTENTIONALLY PUBLIC â€” no authentication required.
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

// â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
app.use("/api/analytics", analyticsRouter);
app.use("/api/graphql", graphqlRouter);
app.use("/api/provider", providerRouter);

// â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get("/health", async (_req, res) => {
  const checks: Record<string, import("./lib/health.js").DependencyCheck> = {};

  try {
    const started = Date.now();
    await server.getLatestLedger();
    checks.stellar_rpc = { status: "up", latency_ms: Date.now() - started };
    checks.contract = { status: "up", last_call: new Date().toISOString() };
  } catch (err) {
    logger.error("Stellar health check failed", { err });
    checks.stellar_rpc = { status: "down", error: "RPC request failed" };
    checks.contract = { status: "down", error: "Contract dependency unavailable" };
  }

  try {
    const database = initUsageEventStore() as { prepare: (sql: string) => { get: () => unknown } };
    database.prepare("SELECT 1").get();
    const dbPath = process.env.USAGE_EVENTS_DB_PATH ?? "data/usage-events.sqlite";
    const sizeMb = statSync(dbPath, { throwIfNoEntry: false })?.size;
    checks.database = { status: "up", size_mb: sizeMb ? Number((sizeMb / 1024 / 1024).toFixed(2)) : 0 };
  } catch (err) {
    logger.error("Database health check failed", { err });
    checks.database = { status: "down", error: "SQLite health check failed" };
  }

  try {
    const client = mqtt.connect(process.env.MQTT_BROKER ?? "mqtt://localhost:1883", {
      reconnectPeriod: 0,
      connectTimeout: 3000,
    });
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { client.end(true); resolve(false); }, 3000);
      client.once("connect", () => { clearTimeout(timer); client.end(true); resolve(true); });
      client.once("error", () => { clearTimeout(timer); client.end(true); resolve(false); });
    });
    checks.mqtt_broker = connected ? { status: "up", connected: true } : { status: "down", connected: false };
  } catch (err) {
    logger.error("MQTT health check failed", { err });
    checks.mqtt_broker = { status: "down", connected: false, error: "MQTT health check failed" };
  }

  const result = buildHealthResponse(checks, STARTED_AT, countDeadLetterEvents());
  res.status(result.httpStatus).json(result.body);
});

// #418: 404 catch-all â€” must come after all routes.
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Route not found",
    code: "NOT_FOUND",
    hint: "Check /api/docs for available endpoints",
    requestId: getReqId(),
  });
});

// â”€â”€ Error handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Timeout error handler.
app.use((err: any, req: any, res: any, next: any) => {
  if (req.timedout) {
    logger.error("Request timed out", { method: req.method, path: req.path });
    return res
      .status(504)
      .json({ error: "Request timed out", code: "TIMEOUT", requestId: getReqId() });
  }
  return next(err);
});

// #423: 413 payload too large handler + global error handler (#418).
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const requestId = getReqId();
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

// â”€â”€ Server startup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.listen(PORT, () => {
// ── Server startup ───────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
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

const graphqlWs = new WebSocketServer({ server: httpServer, path: "/api/graphql" });
const graphqlCleanup = useServer({
  schema,
  context: ({ connectionParams }) => {
    const params = (connectionParams ?? {}) as Record<string, unknown>;
    return { address: typeof params.address === "string" ? params.address : undefined };
  },
  onSubscribe: async (_ctx, _id, msg) => {
    const payload = msg as unknown as { query?: string; variables?: Record<string, unknown>; operationName?: string };
    if (!payload.query) return [];
    return { schema, document: parse(payload.query), rootValue, variableValues: payload.variables, operationName: payload.operationName };
  },
}, graphqlWs);

function shutdown(signal: string): void {
  logger.info({ signal }, "SolarGrid backend shutting down");
  void graphqlCleanup.dispose();
  graphqlWs.close();
  httpServer.close(() => {
    closeAllDatabases();
  });

  const forceExitTimer = setTimeout(() => {
    closeAllDatabases();
    process.exitCode = 1;
  }, 10_000);
  forceExitTimer.unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
