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

/**
 * Merge the current request's correlation ID (if any) into log meta, and
 * strip anything sensitive out of it first.
 *
 * Closes #748: callers across the codebase routinely pass a raw Error (or
 * an object containing one, a request payload, an MQTT message, etc.) as
 * `meta`. Sanitizing centrally here — rather than at each of the ~50
 * call sites — means every logger.* call is protected, including ones
 * added in the future.
 */
function withRequestId(meta: Meta): Meta {
  const requestId = getReqId();
  const safeMeta = sanitizeForLogging(meta) as Meta;
  if (requestId) {
    return { requestId, ...safeMeta };
  }
  return safeMeta;
}

// Pino-style: logger.info({ meta }, "msg") or logger.info("msg")
// Winston-style: logger.info("msg", { meta }) or logger.info("msg")
// This wrapper accepts both call signatures.
function makeLogFn(level: "fatal" | "error" | "warn" | "info" | "debug") {
  return (msgOrMeta: string | Meta, msgOrMeta2?: string | Meta, ...rest: unknown[]) => {
    if (typeof msgOrMeta === "string") {
      // Called as: logger.info("msg", { meta }) — winston style
      const meta = typeof msgOrMeta2 === "object" ? msgOrMeta2 : {};
      winstonLogger.log(level === "fatal" ? "error" : level, msgOrMeta, withRequestId(meta));
    } else {
      // Called as: logger.info({ meta }, "msg") — pino style
      const msg = typeof msgOrMeta2 === "string" ? msgOrMeta2 : String(rest[0] ?? "");
      winstonLogger.log(level === "fatal" ? "error" : level, msg, withRequestId(msgOrMeta as Meta));
    }
  };
}

export const logger = {
  fatal: makeLogFn("fatal"),
  error: makeLogFn("error"),
  warn: makeLogFn("warn"),
  info: makeLogFn("info"),
  debug: makeLogFn("debug"),
};
