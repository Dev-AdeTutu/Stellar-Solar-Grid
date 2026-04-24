import "dotenv/config";
import express from "express";
import { NextFunction, Request, Response } from "express";
import { meterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { webhookRouter } from "./routes/webhooks.js";
import { startIoTBridge } from "./iot/bridge.js";

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

app.use("/api/meters", meterRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhookRouter);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);

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
  console.log(`🌞 SolarGrid backend running on port ${PORT}`);
  startIoTBridge();
});
