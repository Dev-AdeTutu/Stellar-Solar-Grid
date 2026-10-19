import { Request, Response, NextFunction } from "express";
import { getReqId } from "../lib/requestContext.js";

/**
 * Middleware to validate Content-Type header on requests that send payloads (POST, PUT, PATCH).
 * Rejects non-JSON content types with HTTP 415 Unsupported Media Type to prevent parser 500 errors.
 */
export function validateContentType(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();

  // Only validate payload-bearing HTTP methods
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const contentType = req.headers["content-type"];

    if (contentType) {
      const isJson =
        contentType.includes("application/json") ||
        contentType.includes("application/vnd.api+json");
      if (!isJson) {
        return res.status(415).json({
          error: "Unsupported Media Type: Content-Type must be application/json",
          code: "UNSUPPORTED_MEDIA_TYPE",
          requestId: getReqId(),
        });
      }
    } else {
      // Check if body content exists via length or transfer encoding headers
      const contentLength = req.headers["content-length"];
      const transferEncoding = req.headers["transfer-encoding"];
      const hasBody = (contentLength && parseInt(contentLength, 10) > 0) || Boolean(transferEncoding);

      if (hasBody) {
        return res.status(415).json({
          error: "Unsupported Media Type: Content-Type header missing, must be application/json",
          code: "UNSUPPORTED_MEDIA_TYPE",
          requestId: getReqId(),
        });
      }
    }
  }

  return next();
}
