import winston from "winston";
import { getReqId, getRequestId } from "./requestContext.js";
import { sanitizeForLogging } from "./errorSanitizer.js";

const isProduction = process.env.NODE_ENV === "production";
const useJson = (process.env.LOG_FORMAT ?? (isProduction ? "json" : "text")) === "json";
const SERVICE_NAME = "solargrid-backend";

const withRequestIdFormat = winston.format((info) => {
  const requestId = getReqId() ?? getRequestId();
  if (requestId) {
    (info as { request_id?: string }).request_id = requestId;
  }
  return info;
});

const developmentFormat = winston.format.combine(
  withRequestIdFormat(),
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

const structuredFormat = winston.format.combine(
  withRequestIdFormat(),
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.json(),
);

const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  defaultMeta: { service: SERVICE_NAME },
  format: useJson ? structuredFormat : developmentFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

export function getComponentLogger(component: string) {
  return winstonLogger.child({ component });
}

type Meta = Record<string, unknown>;

function withRequestIdMeta(meta: Meta): Meta {
  const requestId = getReqId() ?? getRequestId();
  const safeMeta = sanitizeForLogging(meta) as Meta;
  if (requestId) {
    return { requestId, ...safeMeta };
  }
  return safeMeta;
}

function makeLogFn(level: "fatal" | "error" | "warn" | "info" | "debug") {
  return (msgOrMeta: string | Meta, msgOrMeta2?: string | Meta, ...rest: unknown[]) => {
    if (typeof msgOrMeta === "string") {
      const meta = typeof msgOrMeta2 === "object" && msgOrMeta2 !== null ? msgOrMeta2 : {};
      winstonLogger.log(level === "fatal" ? "error" : level, msgOrMeta, withRequestIdMeta(meta as Meta));
      return;
    }

    const msg = typeof msgOrMeta2 === "string" ? msgOrMeta2 : String(rest[0] ?? "");
    winstonLogger.log(level === "fatal" ? "error" : level, msg, withRequestIdMeta(msgOrMeta as Meta));
  };
}

export const logger = {
  fatal: makeLogFn("fatal"),
  error: makeLogFn("error"),
  warn: makeLogFn("warn"),
  info: makeLogFn("info"),
  debug: makeLogFn("debug"),
};
