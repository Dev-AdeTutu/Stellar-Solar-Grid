/**
 * #763 — Distributed tracing (OpenTelemetry).
 *
 * Initializes a Node tracer that exports spans via OTLP/HTTP — the protocol
 * Jaeger (1.35+) and Zipkin (via the OTel collector) both accept — so a
 * request's path through the backend, MQTT bridge, and Stellar RPC calls can
 * be visualized as a single trace instead of pieced together from logs.
 *
 * Disabled by default in environments that haven't configured a collector:
 * set OTEL_ENABLED=true (or OTEL_EXPORTER_OTLP_ENDPOINT) to turn it on. When
 * disabled, `tracer` still works — every span it creates is a harmless no-op
 * — so instrumented code paths don't need to branch on whether tracing is on.
 */
import { trace, propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { logger } from "./logger.js";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "solargrid-backend";
const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
    : "http://localhost:4318/v1/traces");
const OTEL_ENABLED =
  (process.env.OTEL_ENABLED ??
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? "true"
      : "false")) === "true";

let provider: NodeTracerProvider | undefined;

// Always register the W3C `traceparent`/`tracestate` propagator, even when
// export is disabled, so a trace id arriving from the frontend (or another
// service) still flows through request context and shows up in logs.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

if (OTEL_ENABLED) {
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: OTLP_ENDPOINT }))],
  });
  provider.register();
  logger.info({ endpoint: OTLP_ENDPOINT, service: SERVICE_NAME }, "OpenTelemetry tracing enabled");
} else {
  logger.debug(
    "OpenTelemetry tracing disabled — set OTEL_ENABLED=true (and optionally OTEL_EXPORTER_OTLP_ENDPOINT) to enable",
  );
}

export const tracer = trace.getTracer(SERVICE_NAME);

export async function shutdownTracing(): Promise<void> {
  if (provider) await provider.shutdown();
}
