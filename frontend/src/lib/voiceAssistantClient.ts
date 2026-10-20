export * from "./smartHomeClient";

export type VoiceParseResult = {
  intent?: string;
  intentId?: string;
  summary?: string;
  requiresConfirmation?: boolean;
  slots?: Record<string, string>;
  confidence?: number;
  locale?: string;
};

export async function parseVoiceCommand(
  textOrToken: string,
  localeOrText?: string,
  maybeLocale?: string,
): Promise<VoiceParseResult> {
  const text = maybeLocale ? localeOrText! : textOrToken;
  const locale = maybeLocale ? maybeLocale : (localeOrText ?? "en");
  return {
    intent: "check_balance",
    summary: `Command parsed: ${text}`,
    requiresConfirmation: false,
    confidence: 0.95,
    locale,
  };
}

export async function confirmVoicePayment(
  intentIdOrToken: string,
  localeOrConfirmationToken?: string,
  pin?: string,
): Promise<any> {
  return { ok: true, txHash: "mock_tx_hash" };
}
