import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
import * as OpenApiValidator from "express-openapi-validator";

import { stellarService, server, NETWORK_PASSPHRASE } from "./lib/stellar.js";
import { createMeterRouter } from "./routes/meters.js";
import { paymentsRouter } from "./routes/payments.js";
import { receiptsRouter } from "./routes/receipts.js";
import { certificatesRouter } from "./routes/certificates.js";
import { createMeterQrRouter } from "./routes/meterQr.js";
import { webhookRouter } from "./routes/webhooks.js";
import { complianceRouter, complianceMonitor } from "./routes/compliance.js";
import { benchmarkingRouter } from "./routes/benchmarking.js";
import { educationRouter } from "./routes/education.js";
import { startIoTBridge } from "./iot/bridge.js";
import { auditRouter } from "./routes/audit.js";
import { socialRouter } from "./routes/social.js";
import { startLeaderboardScheduler } from "./lib/social.js";
import { statsRouter } from "./routes/stats.js";
import { collaboratorRouter } from "./routes/collaborators.js";
import { allowlistRouter } from "./routes/allowlist.js";
import { adminLoginRouter } from "./routes/adminLogin.js";
import { metricsRouter } from "./routes/metrics.js";
import { providerRouter } from "./routes/provider.js";
import { smsConfigRouter } from "./routes/smsConfig.js";
import { clientErrorsRouter } from "./routes/clientErrors.js";
import { loadBalancingRouter } from "./routes/loadBalancing.js";
import { twoFactorRouter } from "./routes/twoFactor.js";
import { tradingRouter, attachTradingWebSocket } from "./routes/trading.js";
import { orderBookRouter, attachOrderBookWebSocket } from "./routes/orderBook.js";
import { pushSubscriptionsRouter } from "./routes/pushSubscriptions.js";
import { solarRouter } from "./routes/solar.js";
import { weatherRouter } from "./routes/weather.js";
import { usageEventsRouter } from "./routes/usageEvents.js";
import { analyticsRouter } from "./routes/analytics.js";
import { createMarketAnalyticsRouter } from "./routes/marketAnalytics.js";
import { insightsRouter } from "./routes/insights.js";
import { graphqlRouter } from "./routes/graphql.js";
import { usageRouter } from "./routes/usage.js";
import { meterMapRouter } from "./routes/meterMap.js";
import { delegatesRouter } from "./routes/delegates.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { meterHealthRouter } from "./routes/meterHealth.js";
import { emergencyContactsRouter } from "./routes/emergencyContacts.js";
import { creditScoreRouter } from "./routes/creditScore.js";
import { predictionRouter } from "./routes/prediction.js";
import { billingRouter } from "./routes/billing.js";
import forecastRouter from "./routes/forecast.js";
import { competitionsRouter } from "./routes/competitions.js";
import { communitiesRouter } from "./routes/communities.js";
import { smartHomeRouter } from "./routes/smartHome.js";
import { voiceAssistantRouter } from "./routes/voiceAssistant.js";
import { startVoiceTokenPruner, stopVoiceTokenPruner } from "./lib/voiceAssistant.js";
import { outagesRouter } from "./routes/outages.js";
import { widgetsRouter } from "./routes/widgets.js";
import arbitrageBotRouter from "./routes/arbitrageBot.js";
import { startBillingScheduler, startInstallmentScheduler } from "./lib/billing.js";
import { startCompetitionScheduler } from "./lib/competitions.js";
import { startEnergyForecastRetraining } from "./lib/energyForecast.js";
import { initPriceHeatmap, startPriceSimulation } from "./lib/priceHeatmap.js";
import { consumptionAnalyticsRouter } from "./routes/consumptionAnalytics.js";
import { recsRouter } from "./routes/recs.js";
import { leasesRouter } from "./routes/leases.js";
import { chatbotRouter } from "./routes/chatbot.js";
import { complianceReportsRouter } from "./routes/complianceReports.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { vppRouter } from "./routes/vpp.js";
import { gridServicesRouter } from "./routes/gridServices.js";
import { setRelaySender, startSmartHomeScheduler } from "./lib/smartHome.js";
import { startHealthMonitor } from "./lib/meterHealth.js";
import { startResilienceMonitor } from "./lib/gridResilience.js";
import { gridResilienceRouter } from "./routes/gridResilience.js";
import { privacyRouter } from "./routes/privacy.js";
import { sendRelayCommand, startIoTBridge, stopIoTBridge } from "./iot/bridge.js";
import { startLimitWatcher } from "./iot/limitWatcher.js";
import { startScheduleExecutor } from "./iot/scheduleExecutor.js";
import { logger } from "./lib/logger.js";
import { runWithRequestId } from "./lib/requestContext.js";
import { requestLogger } from "./lib/requestLogger.js";
import { register, updateSqlitePoolMetrics } from "./lib/metrics.js";
import { readLimiter, writeLimiter, paymentsLimiter } from "./middleware/rateLimit.js";
import { payerRateLimiter } from "./middleware/payerRateLimit.js";
import { globalRateLimiter } from "./middleware/globalRateLimit.js";
import { sanitiseBody } from "./middleware/sanitise.js";
import { validateContentType } from "./middleware/validateContentType.js";
import requestLoggerMiddleware from "./middleware/requestLogger.js";
import { tracingMiddleware } from "./middleware/tracing.js";
import { shutdownTracing } from "./lib/tracing.js";
import { getCircuitState } from "./lib/circuitBreaker.js";
import {
  countDeadLetterEvents,
  getUsageEventPoolStatus,
  initUsageEventStore,
  startUsageEventRetryWorker,
  startUsageCompactionWorker,
} from "./lib/usageEvents.js";
import { initMeterNotesStore, getMeterNotesPoolStatus } from "./lib/meterNotes.js";
import { getUsageHistoryPoolStatus } from "./lib/usageHistory.js";
import { closeAllDatabases } from "./lib/databaseLifecycle.js";
import { getReqId } from "./lib/requestContext.js";
import { exportRouter } from "./routes/export.js";
import { pricingRouter } from "./routes/pricing.js";
import { carbonCreditsRouter } from "./routes/carbonCredits.js";
import { p2pTradingRouter } from "./routes/p2pTrading.js";
import { adminDashboardRouter } from "./routes/adminDashboard.js";
import { startPricingScheduler } from "./lib/dynamicPricing.js";
// Issue #696: Import idempotency cleanup for graceful shutdown
import { _stopEvictionTimer } from "./middleware/idempotency.js";
import { buildHealthResponse } from "./lib/health.js";
import { isCorsOriginAllowed, parseCorsOrigins } from "./config/cors.js";
import { startTheftMonitor } from "./lib/theftDetection.js";
import { workOrdersRouter } from "./routes/workOrders.js";
import { surveysRouter } from "./routes/surveys.js";

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
app.use(cors({ exposedHeaders: [
  "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset",
  "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset",
  "X-RateLimit-Policy", "Retry-After",
] }));
app.use(globalRateLimiter);
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface MeterFirmware {
  meterId: string;
  firmwareVersion: string;
  reportedAt: string;
}

app.use(complianceMonitor);
app.use("/api/compliance", complianceRouter);
app.use("/api/benchmarking", benchmarkingRouter);
app.use("/api/education", educationRouter);
app.use("/api/meters", createMeterRouter(stellarService));
app.use("/api/payments", paymentsRouter);
app.use("/api/webhooks", webhookRouter);
app.use("/api/audit", auditRouter);
app.use("/api/social", socialRouter);
startLeaderboardScheduler();
const firmwareByMeter = new Map<string, MeterFirmware>();

const LATEST_FIRMWARE_VERSION = process.env.LATEST_FIRMWARE_VERSION || '1.0.0';

function isOutdated(version: string): boolean {
  return version !== LATEST_FIRMWARE_VERSION;
}

app.use("/api/admin", writeLimiter, adminLoginRouter);
app.use("/api/meters/map", meterMapRouter);
app.use("/api/keys", writeLimiter, apiKeysRouter);
app.use("/api/meters", meterHealthRouter);
app.use("/api/users/emergency-contacts", emergencyContactsRouter);
app.use("/api/users", writeLimiter, creditScoreRouter);
app.use("/api/meters", predictionRouter);
// #982: weather-aware forecast endpoint (GET /api/meters/:meterId/forecast)
app.use("/api/meters", createWeatherForecastRouter());
// #983: appliance breakdown endpoint (GET /api/meters/:meterId/appliances)
app.use("/api/meters", createApplianceRouter());
startHealthMonitor();
// Body parsing above makes payer/owner available before this limiter runs.
// Missing payer identities remain governed by the global IP limiter.
app.use("/api/meters", payerRateLimiter, createMeterRouter(stellarService));
app.use("/api/payments", payerRateLimiter, writeLimiter, paymentsRouter);
app.use("/api/export", exportRouter);
app.use("/api/certificates", certificatesRouter);
app.use("/api/delegates", writeLimiter, delegatesRouter);
app.use("/api/webhooks", writeLimiter, webhookRouter);
app.use("/api/allowlist", writeLimiter, allowlistRouter);
app.use("/api/collaborators", collaboratorRouter);
app.use("/api/sms-config", smsConfigRouter);
app.use("/api/client-errors", writeLimiter, clientErrorsRouter);
app.use("/api/push", writeLimiter, pushSubscriptionsRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/email-notifications", emailNotificationsRouter);
app.use("/api/solar", solarRouter);
app.use("/api/weather", weatherRouter);
app.use("/api/usage-events", usageEventsRouter);
app.use("/api/usage", usageRouter);
app.use("/api/analytics/market", createMarketAnalyticsRouter(initUsageEventStore));
app.use("/api/analytics", analyticsRouter);
app.use("/api/meters", insightsRouter);
app.use("/api/graphql", graphqlRouter);
app.use("/graphql", graphqlRouter);
app.use("/api/provider", providerRouter);
// #901–#904: widgets, billing, competitions, smart home
app.use("/api/widgets", widgetsRouter);
app.use("/api/backtest", backtestRouter);
app.use("/api/billing", writeLimiter, billingRouter);
app.use("/api/competitions", competitionsRouter);
app.use("/api/communities", communitiesRouter);
app.use("/api/smart-home", smartHomeRouter);
// #989: voice assistant (Alexa / Google Assistant) skill endpoints
app.use("/api/voice", readLimiter, voiceAssistantRouter);
app.use("/api/voice/payments", writeLimiter, voiceAssistantRouter);
startVoiceTokenPruner();
app.use("/api/forecast", forecastRouter);
setRelaySender(sendRelayCommand);
// Initialize heatmap system (#922)
initPriceHeatmap();
startPriceSimulation();
startBillingScheduler();
startInstallmentScheduler();
startCompetitionScheduler();
startEnergyForecastRetraining();
// #982: retrain the weather-aware forecasting model alongside the consumption model
startWeatherForecastRetraining();
// #983: retrain the appliance disaggregation model
startApplianceDisaggregationRetraining();
startSmartHomeScheduler();
// #877: dynamic pricing
app.use("/api/pricing", pricingRouter);
startPricingScheduler();
// #878: carbon credit tracking
app.use("/api/carbon-credits", carbonCreditsRouter);
// #879: P2P energy trading
app.use("/api/p2p", p2pTradingRouter);
// #935: order book
app.use("/api/orderbook", orderBookRouter);
// #880: admin dashboard
app.use("/api/admin/dashboard", adminDashboardRouter);
// #941: grid resilience scoring
app.use("/api/grid", gridResilienceRouter);
app.use("/api/grid-services", gridServicesRouter);
startResilienceMonitor();
// #939: energy data privacy controls
app.use("/api/privacy", writeLimiter, privacyRouter);
// #991: contractor/technician portal
app.use("/api/work-orders", writeLimiter, workOrdersRouter);
// #994: customer satisfaction surveys
app.use("/api/surveys", writeLimiter, surveysRouter);

// #979: scheduled maintenance windows
app.use("/api/maintenance", writeLimiter, maintenanceRouter);
startMaintenanceScheduler();

// #976: grid outage detection and notifications
app.use("/api/outages", writeLimiter, outagesRouter);

// #985: automatic meter firmware updates (OTA)
app.use("/api/firmware", writeLimiter, firmwareRouter);

// â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const mqttUrl = process.env.MQTT_URL || 'mqtt://localhost:1883';
const mqttClient = mqtt.connect(mqttUrl);

mqttClient.on('connect', () => {
  mqttClient.subscribe('meters/+/telemetry');
});

mqttClient.on('message', (topic: string, payload: Buffer) => {
  try {
    const data = JSON.parse(payload.toString());
    const parts = topic.split('/');
    const meterId = data.meterId || parts[1];
    if (!meterId) {
      return;
    }
    if (typeof data.firmware_version === 'string' && data.firmware_version.length > 0) {
      const record = recordFirmware(meterId, data.firmware_version);
      if (isOutdated(record.firmwareVersion)) {
        console.warn(
          `Meter ${meterId} is running outdated firmware ${record.firmwareVersion} (latest ${LATEST_FIRMWARE_VERSION})`
        );
      }
    }
  } catch (err) {
    console.error('Failed to parse MQTT payload', err);
  }
});

app.get('/api/meters/firmware-report', (_req: Request, res: Response) => {
  const report = Array.from(firmwareByMeter.values()).map((record) => ({
    ...record,
    outdated: isOutdated(record.firmwareVersion),
  }));
  res.json({
    latestFirmwareVersion: LATEST_FIRMWARE_VERSION,
    meters: report,
  });
});

app.get('/api/meters/:meterId/firmware', (req: Request, res: Response) => {
  const record = firmwareByMeter.get(req.params.meterId);
  if (!record) {
    return res.status(404).json({ error: 'No firmware version recorded for meter' });
  }
  res.json({
    ...record,
    outdated: isOutdated(record.firmwareVersion),
    latestFirmwareVersion: LATEST_FIRMWARE_VERSION,
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

const httpServer = app.listen(PORT, () => {
  logger.info({ port: PORT, network: process.env.STELLAR_NETWORK ?? "testnet" }, "SolarGrid backend started");
  initUsageEventStore();
  startUsageEventRetryWorker();
  logger.info("SolarGrid backend listening", { port: PORT });
  startLimitWatcher(stellarService);
  startScheduleExecutor(stellarService);
  try {
    startIoTBridge();
  } catch (err) {
    logger.error("Failed to start IoT bridge", { err });
  }
  // #993: listen for diagnostic results reported by meters over MQTT
  try {
    startDiagnosticResultListener();
  } catch (err) {
    logger.error("Failed to start diagnostic result listener", { err });
  }
});
attachTradingWebSocket(httpServer);
attachOrderBookWebSocket(httpServer);
attachWidgetLiveUpdates(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  startTheftMonitor();
  startEventIndexer();
  startRecommendationWorker();
});

export { app, pool, recordFirmware, isOutdated, firmwareByMeter, stopVoiceTokenPruner };

// #923: Arbitrage Trading Bot
app.use("/api/arbitrage", arbitrageBotRouter);

// #928: AI energy consumption pattern analysis
app.use("/api/analytics/patterns", consumptionAnalyticsRouter);

// #927: Renewable Energy Credit marketplace
app.use("/api/recs", recsRouter);
app.use("/api/leases", leasesRouter);
app.use("/api/chatbot", chatbotRouter);
app.use("/api/reports", complianceReportsRouter);

// #926: Energy portfolio management
app.use("/api/portfolio", portfolioRouter);

// #925: Virtual power plant aggregation
app.use("/api/vpp", vppRouter);

// #1006: Meter Network Topology Visualization
import { networkTopologyRouter } from "./routes/networkTopology.js";
app.use("/api/network", networkTopologyRouter);

// #1005: White-Label Provider Customization
import { providersBrandingRouter } from "./routes/providersBranding.js";
app.use("/api/providers", providersBrandingRouter);

// #1004: Blockchain Transaction History Explorer
import { transactionsRouter } from "./routes/transactions.js";
app.use("/api/transactions", transactionsRouter);

// #1065: Energy Certificate Authority
import { energyCertificatesRouter } from "./routes/energyCertificates.js";
app.use("/api/energy-certificates", writeLimiter, energyCertificatesRouter);

// #1066: Meter Behavioral Economics Nudges
import { nudgesRouter } from "./routes/nudges.js";
app.use("/api/nudges", nudgesRouter);

// #1068: Energy Commons Management
import { commonsRouter } from "./routes/commons.js";
app.use("/api/commons", writeLimiter, commonsRouter);

