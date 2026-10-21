const DEFAULT_CORS_ORIGINS = ['http://localhost:3000'];

function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** Parse and validate the comma-separated CORS_ORIGINS environment value. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_CORS_ORIGINS];

  const origins = [...new Set(raw.split(',').map((origin) => origin.trim()).filter(Boolean))];
  const invalid = origins.filter((origin) => !isValidOrigin(origin));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid CORS_ORIGINS value(s): ${invalid.join(', ')}. Origins must be absolute http:// or https:// URLs without paths.`,
    );
  }

  return origins;
}

export function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  return !origin || allowedOrigins.includes(origin);
}

export { DEFAULT_CORS_ORIGINS };
