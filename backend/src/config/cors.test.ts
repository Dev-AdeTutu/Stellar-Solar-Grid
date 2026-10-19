import { describe, expect, it } from 'vitest';
import { DEFAULT_CORS_ORIGINS, isCorsOriginAllowed, parseCorsOrigins } from './cors.js';

describe('parseCorsOrigins', () => {
  it('uses localhost when CORS_ORIGINS is not configured', () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS);
  });

  it('parses, trims, and de-duplicates configured origins', () => {
    expect(
      parseCorsOrigins(' https://app.solargrid.io,https://staging.solargrid.io, https://app.solargrid.io '),
    ).toEqual(['https://app.solargrid.io', 'https://staging.solargrid.io']);
  });

  it('rejects malformed origins before the server starts', () => {
    expect(() => parseCorsOrigins('https://app.solargrid.io,/bad-origin')).toThrow(/Invalid CORS_ORIGINS/);
    expect(() => parseCorsOrigins('https://app.solargrid.io/path')).toThrow(/without paths/);
  });
});

describe('isCorsOriginAllowed', () => {
  it('allows non-browser requests and configured origins only', () => {
    const allowed = ['http://localhost:3000'];
    expect(isCorsOriginAllowed(undefined, allowed)).toBe(true);
    expect(isCorsOriginAllowed('http://localhost:3000', allowed)).toBe(true);
    expect(isCorsOriginAllowed('https://attacker.example', allowed)).toBe(false);
  });
});
