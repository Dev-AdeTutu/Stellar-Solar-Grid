import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import { meterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { requestContext } from "./lib/requestContext.js";
import { startIoTBridge } from "./iot/bridge.js";

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
app.use((req, res, next) => {
  const reqId = (req.headers["x-request-id"] as string) ?? randomUUID();
  res.setHeader("x-request-id", reqId);
  requestContext.run({ reqId }, next);
});
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use("/api/meters", meterRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhookRouter);
app.use("/api/allowlist", allowlistRouter);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`🌞 SolarGrid backend running on port ${PORT}`);
  startIoTBridge();
});
