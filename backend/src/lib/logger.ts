import winston from "winston";

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
  transports: [new winston.transports.Console()],
});

type Meta = Record<string, unknown>;

// Pino-style: logger.info({ meta }, "msg") or logger.info("msg")
// Winston-style: logger.info("msg", { meta }) or logger.info("msg")
// This wrapper accepts both call signatures.
function makeLogFn(level: "fatal" | "error" | "warn" | "info" | "debug") {
  return (msgOrMeta: string | Meta, msgOrMeta2?: string | Meta, ...rest: unknown[]) => {
    if (typeof msgOrMeta === "string") {
      // Called as: logger.info("msg", { meta }) — winston style
      const meta = typeof msgOrMeta2 === "object" ? msgOrMeta2 : {};
      winstonLogger.log(level === "fatal" ? "error" : level, msgOrMeta, meta);
    } else {
      // Called as: logger.info({ meta }, "msg") — pino style
      const msg = typeof msgOrMeta2 === "string" ? msgOrMeta2 : String(rest[0] ?? "");
      winstonLogger.log(level === "fatal" ? "error" : level, msg, msgOrMeta as Meta);
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
