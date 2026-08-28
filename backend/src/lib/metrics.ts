import { Counter, Gauge, register } from "prom-client";

export const mqttMessages = new Counter({
  name: "solargrid_mqtt_messages_total",
  help: "Total MQTT messages received",
  labelNames: ["topic"] as const,
});

export const contractCalls = new Counter({
  name: "solargrid_contract_invocations_total",
  help: "Contract calls by method and status",
  labelNames: ["method", "status"] as const,
});

export const activeMeters = new Gauge({
  name: "solargrid_active_meters",
  help: "Number of currently active meters",
  labelNames: ["meter_id"] as const,
});

export const paymentVolume = new Counter({
  name: "solargrid_payment_volume_xlm",
  help: "Total XLM processed in payments",
  labelNames: ["plan"] as const,
});

export const webhookDeliveries = new Counter({
  name: "solargrid_webhook_deliveries_total",
  help: "Total webhook delivery attempts by status and attempt count",
  labelNames: ["status", "attempt"] as const,
});

/**
 * #529 — Counts webhook deliveries that exhausted all retry attempts and
 * failed permanently. The URL is SHA-256-hashed (first 12 hex chars) to
 * avoid leaking PII / full URLs into metric labels while still allowing
 * per-endpoint differentiation in Grafana.
 */
export const webhookDeliveryFailures = new Counter({
  name: "solargrid_webhook_delivery_failures_total",
  help: "Webhook deliveries that failed permanently after exhausting all retries (URL is hashed for privacy)",
  labelNames: ["url_hash"] as const,
});

export const usageEvents = new Counter({
  name: "solargrid_usage_events_total",
  help: "Total usage events by status",
  labelNames: ["status"] as const,
});

/**
 * #528 — Flips to 1 when MQTT reconnect attempts are exhausted so Grafana
 * alerting can page on-call without polling logs.
 */
export const mqttReconnectExhausted = new Gauge({
  name: "solargrid_mqtt_reconnect_exhausted",
  help: "1 when MQTT reconnect attempts have been exhausted and the bridge has stopped, 0 otherwise",
});

export const deadLetterEvents = new Counter({
  name: "solargrid_dead_letter_events_total",
  help: "Usage events moved to dead-letter state after exhausting all retries",
  labelNames: ["meter_id"] as const,
});

export const contractEventsProcessed = new Counter({
  name: "solargrid_contract_events_processed_total",
  help: "Total contract events processed by the bridge, by topic",
  labelNames: ["topic"] as const,
});

/**
 * #735 — Live SQLite connection pool usage. `dimension` is one of
 * `size` / `active` / `idle`; `database` identifies the pool
 * (`usage-events`, `meter-notes`). Lets Grafana alert on pool exhaustion
 * (active === size === max) before request latency degrades.
 */
export const sqlitePool = new Gauge({
  name: "solargrid_sqlite_pool",
  help: "SQLite connection pool usage by database and dimension (size/active/idle)",
  labelNames: ["database", "dimension"] as const,
});

// ── Atomic Metric Increment Helpers ──────────────────────────────────────────
// Use prom-client native atomic counter increments (counter.inc) to prevent
// race conditions and lost increments under high concurrency (#706).

/** Atomic increment for MQTT messages counter */
export const incrementMqtt = (topic?: string, count: number = 1): void => {
  mqttMessages.inc({ topic: topic ?? "solargrid/meters" }, count);
};

/** Atomic increment for contract invocations counter */
export const incrementContractCall = (
  method: string,
  status: "success" | "error",
  count: number = 1,
): void => {
  contractCalls.inc({ method, status }, count);
};

/** Atomic increment for payment volume counter */
export const incrementPaymentVolume = (plan: string, amountXlm: number): void => {
  paymentVolume.inc({ plan }, amountXlm);
};

/** Atomic increment for webhook deliveries counter */
export const incrementWebhookDelivery = (
  status: string,
  attempt: number | string,
  count: number = 1,
): void => {
  webhookDeliveries.inc({ status, attempt: String(attempt) }, count);
};

/** Atomic increment for permanent webhook delivery failures */
export const incrementWebhookFailure = (urlHash: string, count: number = 1): void => {
  webhookDeliveryFailures.inc({ url_hash: urlHash }, count);
};

/** Atomic increment for usage events counter */
export const incrementUsageEvent = (status: string, count: number = 1): void => {
  usageEvents.inc({ status }, count);
};

/** Atomic increment for dead-letter events counter */
export const incrementDeadLetter = (meterId: string, count: number = 1): void => {
  deadLetterEvents.inc({ meter_id: meterId }, count);
};

/** Atomic increment for contract events processed counter */
export const incrementContractEvent = (topic: string, count: number = 1): void => {
  contractEventsProcessed.inc({ topic }, count);
};

export { register };
