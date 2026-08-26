import winston from "winston";
import { getRequestId } from "./requestContext.js";

const isProduction = process.env.NODE_ENV === "production";
// LOG_FORMAT lets structured JSON logging be forced/disabled independently of
// NODE_ENV (e.g. to test JSON output locally). Defaults to "json" in
// production and "text" everywhere else.
const useJson = (process.env.LOG_FORMAT ?? (isProduction ? "json" : "text")) === "json";

const SERVICE_NAME = "solargrid-backend";

/** Injects the current request's id (set by the request-context middleware) into every log line. */
const withRequestId = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId) {
    info.request_id = requestId;
  }
  return info;
});

const developmentFormat = winston.format.combine(
  withRequestId(),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, request_id, ...meta }) => {
    const metaKeys = Object.keys(meta);
    const metaStr = metaKeys.length > 0 ? ` ${JSON.stringify(meta)}` : "";
    const reqStr = request_id ? ` [${request_id}]` : "";
    return `${timestamp} ${level}${reqStr} ${message}${metaStr}`;
  }),
);

// Structured JSON logs for machine consumption (ELK, Datadog, CloudWatch, ...).
// Every line carries a consistent set of fields: timestamp, level, service,
// component, message, request_id (when available), plus any extra metadata.
// Errors are logged with their stack trace under an `error` field rather
// than being stringified away.
const structuredFormat = winston.format.combine(
  withRequestId(),
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.json(),
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  defaultMeta: { service: SERVICE_NAME },
  format: useJson ? structuredFormat : developmentFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

/** Returns a child logger that tags every log line with a `component` field. */
export function getComponentLogger(component: string) {
  return logger.child({ component });
}
