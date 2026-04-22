import "dotenv/config";
import express from "express";
import { meterRouter } from "./routes/meters.js";
import { webhookRouter } from "./routes/webhooks.js";
import { authRouter } from "./routes/auth.js";
import { startIoTBridge, mqttStatus } from "./iot/bridge.js";

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

app.use("/api/auth", authRouter);
app.use("/api/meters", meterRouter);
app.use("/api/webhooks", webhookRouter);

app.get("/health", (_, res) => {
  const mqttDownMs = mqttStatus.disconnectedSince
    ? Date.now() - mqttStatus.disconnectedSince.getTime()
    : 0;

  res.json({
    status: "ok",
    mqtt: {
      connected: mqttStatus.connected,
      lastConnectedAt: mqttStatus.lastConnectedAt,
      disconnectedSince: mqttStatus.disconnectedSince,
      downSeconds: Math.round(mqttDownMs / 1000),
    },
  });
});

app.listen(PORT, () => {
  console.log(`🌞 SolarGrid backend running on port ${PORT}`);
  startIoTBridge();
});
