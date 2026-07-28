import { Counter, Gauge, register } from "prom-client";

export const mqttMessages = new Counter({
  name: "solargrid_mqtt_messages_total",
  help: "Total MQTT messages received",
});

export const contractCalls = new Counter({
  name: "solargrid_contract_invocations_total",
  help: "Contract calls by method and status",
  labelNames: ["method", "status"] as const,
});

export const activeMeters = new Gauge({
  name: "solargrid_active_meters",
  help: "Number of currently active meters",
});

export const paymentVolume = new Counter({
  name: "solargrid_payment_volume_xlm",
  help: "Total XLM processed in payments",
});

export const deadLetterEvents = new Counter({
  name: "solargrid_dead_letter_events_total",
  help: "Usage events moved to dead-letter state after exhausting all retries",
  labelNames: ["meter_id"] as const,
});

export { register };
