const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

export interface Sep7PaymentOptions {
  destination: string;
  amount?: string | number;
  memo?: string;
  message?: string;
}

/** Build a wallet-compatible SEP-0007 payment URI for a SolarGrid meter. */
export function buildSep7PaymentUri({ destination, amount, memo, message }: Sep7PaymentOptions): string {
  if (!STELLAR_ADDRESS.test(destination)) {
    throw new Error('A valid Stellar destination address is required');
  }
  const params = new URLSearchParams({ destination });
  if (amount !== undefined && String(amount).trim() !== '') params.set('amount', String(amount));
  if (memo) params.set('memo', memo);
  if (message) params.set('msg', message);
  return `web+stellar:pay?${params.toString()}`;
}
