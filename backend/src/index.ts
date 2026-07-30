import "dotenv/config";
import { createRequire } from "module";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import timeout from "connect-timeout";
import mqtt from "mqtt";
import { stellarService, server } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { statsRouter } from "./routes/stats.js";
import { deadLettersRouter } from "./routes/deadLetters.js";
import { metricsRouter } from "./routes/metrics.js";
import { providerRouter } from "./routes/provider.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { usageEventsRouter } from "./routes/usageEvents.js";
import { startIoTBridge } from "./iot/bridge.js";
import { logger } from "./lib/logger.js";
import { register } from "./lib/metrics.js";
import { writeLimiter, paymentsLimiter } from "./middleware/rateLimit.js";
import { sanitiseBody } from "./middleware/sanitise.js";
import requestLoggerMiddleware from "./middleware/requestLogger.js";
import {
  initUsageEventStore,
  startUsageEventRetryWorker,
  countDeadLetterEvents,
} from "./lib/usageEvents.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { getReqId } from "./lib/requestContext.js";
import { initMeterNotesStore } from "./lib/meterNotes.js";

const PORT = process.env.PORT ?? 3001;
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT ?? "100kb";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Key"],
    optionsSuccessStatus: 204,
  }),
);

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

const requestTimeout = process.env.REQUEST_TIMEOUT ?? "15s";
app.use(timeout(requestTimeout));

app.use((req: any, _res: any, next: any) => {
  if (!req.timedout) next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use("/api/admin/login", writeLimiter, adminLoginRouter);
app.use("/api/meters", createMeterRouter(stellarService));
app.use("/api/payments", writeLimiter, paymentsRouter);
app.use("/api/webhooks", writeLimiter, webhookRouter);
app.use("/api/allowlist", writeLimiter, allowlistRouter);
app.use("/api/stats", statsRouter);
app.use("/api/collaborators", collaboratorRouter);
app.use("/api/sms-config", smsConfigRouter);
app.use("/api/client-errors", writeLimiter, clientErrorsRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/admin/dead-letters", deadLettersRouter);
app.use("/api/provider", providerRouter);
app.use("/api/usage-events", usageEventsRouter);

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};

  try {
    await server.getLatestLedger();
    checks.stellar = "ok";
  } catch (err) {
    logger.error("Stellar health check failed", { err });
    checks.stellar = "error";
  }

  const broker = process.env.MQTT_BROKER ?? "mqtt://localhost:1883";
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

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ── Error handlers ────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) =>
  res.status(404).json({ error: "Route not found", code: "NOT_FOUND" }),
);

app.use((err: any, req: any, res: Response, _next: NextFunction) => {
  if (req.timedout) {
    logger.error("Request timed out", { method: req.method, path: req.path, timeout: requestTimeout });
    return res.status(504).json({ error: "Request timed out", code: "TIMEOUT" });
  }

  logger.error({ error: err.message, stack: err.stack }, "Unhandled error");

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
  }
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && (err as any).body !== undefined)) {
    return res.status(400).json({ error: "Invalid JSON body", code: "INVALID_JSON" });
  }
  if ((err as any).status === 404) {
    return res.status(404).json({ error: "Resource not found", code: "NOT_FOUND" });
  }
  if (err.code === "VALIDATION_ERROR" && err.details) {
    return res
      .status(400)
      .json({ error: "Validation failed", code: "VALIDATION_ERROR", details: err.details, requestId });
  }
  res.status(500).json({ error: err.message || "Internal server error", code: "INTERNAL_ERROR" });
});

// ── Startup ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info({ port: PORT, network: process.env.STELLAR_NETWORK ?? "testnet" }, "SolarGrid backend started");
  initUsageEventStore();
  initMeterNotesStore();
  startUsageEventRetryWorker();
  try {
    startIoTBridge();
  } catch (err) {
    logger.error("Failed to start IoT bridge", { err });
  }
});
