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

export const usageEvents = new Counter({
  name: "solargrid_usage_events_total",
  help: "Total usage events by status",
  labelNames: ["status"] as const,
});

export { register };
