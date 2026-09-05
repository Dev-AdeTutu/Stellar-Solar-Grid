import winston from "winston";
import { getReqId } from "./requestContext.js";
import { sanitizeForLogging } from "./errorSanitizer.js";

const isProduction = process.env.NODE_ENV === "production";

const fmt = isProduction
  ? winston.format.combine(winston.format.timestamp(), winston.format.json())
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: "HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
        return `${timestamp} ${level} ${message}${metaStr}`;
      }),
    );

const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: fmt,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

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
