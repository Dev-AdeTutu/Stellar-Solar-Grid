import "dotenv/config";
import express from "express";
import { meterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { startIoTBridge } from "./iot/bridge.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use("/api/meters", meterRouter);
app.use("/api/payments", paymentsRouter);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`🌞 SolarGrid backend running on port ${PORT}`);
  startIoTBridge();
});
