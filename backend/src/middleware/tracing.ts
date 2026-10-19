/**
 * #763 — wraps every request in a span, extracting any inbound `traceparent`
 * header (e.g. from the frontend, see frontend/src/lib/tracing.ts) so the
 * request joins an existing trace instead of starting a new one. The
 * resulting trace id is echoed back as `X-Trace-Id` so it can be correlated
 * with the `X-Request-ID` already in logs (see requestContext.ts).
 */
import { NextFunction, Request, Response } from "express";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "../lib/tracing.js";

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const parentContext = propagation.extract(context.active(), req.headers);

  context.with(parentContext, () => {
    const span = tracer.startSpan(
      `${req.method} ${req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.method": req.method,
          "http.target": req.originalUrl,
        },
      },
      context.active(),
    );

    res.setHeader("X-Trace-Id", span.spanContext().traceId);

    context.with(trace.setSpan(context.active(), span), () => {
      res.on("finish", () => {
        span.setAttribute("http.status_code", res.statusCode);
        if (res.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end();
      });
      next();
    });
  });
}
