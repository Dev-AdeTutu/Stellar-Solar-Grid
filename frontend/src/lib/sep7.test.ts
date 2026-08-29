import { describe, expect, it } from 'vitest';
import { buildSep7PaymentUri } from './sep7';

describe('buildSep7PaymentUri', () => {
  const destination = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  it('builds an encoded SEP-0007 payment URI', () => {
    const uri = buildSep7PaymentUri({
      destination,
      amount: 5,
      memo: 'METER123',
      message: 'Energy Payment',
    });
    expect(uri).toContain('web+stellar:pay?');
    expect(uri).toContain(`destination=${destination}`);
    expect(uri).toContain('amount=5');
    expect(uri).toContain('memo=METER123');
    expect(uri).toContain('msg=Energy+Payment');
  });

  it('rejects malformed Stellar destinations', () => {
    expect(() => buildSep7PaymentUri({ destination: 'not-an-address' })).toThrow(/valid Stellar/);
  });
});
