export interface SmsProviderConfig {
  shortcode: string;
  provider: string;
  instructions?: string;
}

const DEFAULT_REGION = "default";

const BUILT_IN_CONFIGS: Record<string, SmsProviderConfig> = {
  [DEFAULT_REGION]: {
    shortcode: process.env.SMS_SHORTCODE_DEFAULT ?? "20880",
    provider: "default",
  },
  NG: {
    shortcode: process.env.SMS_SHORTCODE_NG ?? "20880",
    provider: "MTN Nigeria",
  },
  KE: {
    shortcode: process.env.SMS_SHORTCODE_KE ?? "40100",
    provider: "Safaricom Kenya",
    instructions: "Dial the shortcode from any Safaricom line — standard SMS rates apply.",
  },
};

function loadOverridesFromEnv(): Record<string, SmsProviderConfig> {
  const raw = process.env.SMS_PROVIDER_CONFIG_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, SmsProviderConfig>;
  } catch {
    return {};
  }
}

const configs: Record<string, SmsProviderConfig> = {
  ...BUILT_IN_CONFIGS,
  ...loadOverridesFromEnv(),
};

/**
 * Looks up the SMS shortcode/provider to display for a given region code
 * (e.g. "NG", "KE"), falling back to the default config when the region is
 * missing or unrecognized. Lets deployments configure per-region/per-provider
 * shortcodes (SMS_PROVIDER_CONFIG_JSON or SMS_SHORTCODE_<REGION> env vars)
 * without a frontend rebuild.
 */
export function getSmsProviderConfig(region?: string | null): SmsProviderConfig {
  const key = region?.toUpperCase();
  if (key && configs[key]) return configs[key];
  return configs[DEFAULT_REGION];
}
