/**
 * #763 — Generates a W3C Trace Context `traceparent` header so a trace
 * started by a user action (e.g. a button click) continues into the
 * backend span for the resulting API call, instead of the backend minting a
 * disconnected trace id of its own. See backend/src/lib/tracing.ts and
 * backend/src/middleware/tracing.ts for the receiving end.
 *
 * This intentionally doesn't pull in the full @opentelemetry/* SDK client
 * side — the frontend only needs to mint an id and format the header, not
 * record or export spans itself.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds a fresh `traceparent` header value (version 00, sampled). */
export function buildTraceparent(): string {
  const traceId = randomHex(16); // 128-bit trace id
  const spanId = randomHex(8); // 64-bit span id
  return `00-${traceId}-${spanId}-01`;
}
