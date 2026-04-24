import "dotenv/config";
import express from "express";
import { meterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { startIoTBridge } from "./iot/bridge.js";
import { logger } from "./lib/logger.js";
import { register } from "./lib/metrics.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

// Capture raw body for webhook signature verification before JSON parsing
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path });
  next();
});

app.use("/api/meters", meterRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhookRouter);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  logger.info(`SolarGrid backend running on port ${PORT}`);
  startIoTBridge();
});
