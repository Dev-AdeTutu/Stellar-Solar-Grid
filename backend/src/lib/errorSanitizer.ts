/**
 * Central redaction used by the logger (and anything else that writes
 * caller-controlled data to logs) before it reaches winston.
 *
 * Closes #748: error handlers previously logged raw Error objects and
 * request payloads as-is, which could carry wallet secret keys, API keys
 * pulled from env vars, or full XDR transaction envelopes into log output.
 */

// Field names (case-insensitive substring match) whose values are never
// written to logs, regardless of where in the object tree they appear.
export const SENSITIVE_FIELDS = [
  "secret",
  "adminsecretkey",
  "admin_secret_key",
  "secretkey",
  "secret_key",
  "privatekey",
  "private_key",
  "password",
  "apikey",
  "api_key",
  "token",
  "authorization",
  "cookie",
  "signature",
  "seed",
  "mnemonic",
];

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_FIELDS.some((field) => normalized.includes(field));
}

// A Stellar secret key ("S" + 55 base32 chars). Public addresses (G.../C...)
// are not secret and are left untouched — they're routinely needed to debug
// a request and aren't sensitive on their own.
const STELLAR_SECRET_KEY_PATTERN = /\bS[A-Z2-7]{55}\b/g;

// Long base64-ish runs are almost always a signed XDR envelope or similar
// binary blob serialized as text — not useful in a log line, and sometimes
// the signed payload itself, so it's redacted rather than truncated-but-kept.
const LONG_BASE64_PATTERN = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

function redactString(value: string): string {
  return value
    .replace(STELLAR_SECRET_KEY_PATTERN, REDACTED)
    .replace(LONG_BASE64_PATTERN, REDACTED);
}

/** Deep-clones a value, replacing any sensitive-keyed values with "[REDACTED]". */
export function redact(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet());
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;

  if (seen.has(value as object)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";

  // Only safe, non-sensitive Error properties are kept — message/stack are
  // scanned for embedded secrets the same way plain strings are. Custom
  // properties some libraries attach (e.g. an axios error's `.config` with
  // request headers, or a webhook error's `.response`) are dropped rather
  // than risk leaking whatever they happen to carry.
  if (value instanceof Error) {
    seen.add(value);
    return {
      name: value.name,
      message: redactString(value.message),
      code: (value as { code?: unknown }).code,
      stack: typeof value.stack === "string" ? redactString(value.stack) : undefined,
    };
  }

  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(val, depth + 1, seen);
  }
  return out;
}

/** Sanitizes a full log `meta` object (or a bare Error passed as meta) for safe logging. */
export function sanitizeForLogging<T>(meta: T): T {
  return sanitizeValue(meta, 0, new WeakSet()) as T;
}
