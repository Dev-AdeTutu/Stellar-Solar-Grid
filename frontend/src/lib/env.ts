import { z } from "zod";

/**
 * Single validated source for all NEXT_PUBLIC_* env vars.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_X` at build time via static
 * text replacement — each var must be referenced as a literal property
 * access below (not dynamically, e.g. `process.env[key]`) or it won't be
 * inlined into the client bundle.
 */
const envSchema = z.object({
  NEXT_PUBLIC_BACKEND_URL: z.string().url().default("http://localhost:3001"),
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3001"),
  NEXT_PUBLIC_COLLAB_API_URL: z.string().url().default("http://localhost:3000/api/v1"),
  NEXT_PUBLIC_NETWORK_PASSPHRASE: z.string().min(1).default("Test SDF Network ; September 2015"),
  NEXT_PUBLIC_CONTRACT_ID: z
    .string()
    .min(1, "NEXT_PUBLIC_CONTRACT_ID is required — set it in .env.local (see .env.example)"),
  NEXT_PUBLIC_PAYMENT_DESTINATION: z.string().optional(),
  NEXT_PUBLIC_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  NEXT_PUBLIC_SMS_SHORTCODE: z.string().min(1).default("20880"),
  NEXT_PUBLIC_SMS_WEBHOOK_DOCS: z
    .string()
    .url()
    .default("https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/blob/main/backend/README.md"),
  NEXT_PUBLIC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  NEXT_PUBLIC_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
});

function loadEnv() {
  const raw = {
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_COLLAB_API_URL: process.env.NEXT_PUBLIC_COLLAB_API_URL,
    NEXT_PUBLIC_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
    NEXT_PUBLIC_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
    NEXT_PUBLIC_PAYMENT_DESTINATION: process.env.NEXT_PUBLIC_PAYMENT_DESTINATION,
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
    NEXT_PUBLIC_SMS_SHORTCODE: process.env.NEXT_PUBLIC_SMS_SHORTCODE,
    NEXT_PUBLIC_SMS_WEBHOOK_DOCS: process.env.NEXT_PUBLIC_SMS_WEBHOOK_DOCS,
    NEXT_PUBLIC_REQUEST_TIMEOUT_MS: process.env.NEXT_PUBLIC_REQUEST_TIMEOUT_MS,
    NEXT_PUBLIC_POLL_INTERVAL_MS: process.env.NEXT_PUBLIC_POLL_INTERVAL_MS,
  };

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCheck your .env.local against .env.example.`,
    );
  }
  return result.data;
}

export const env = loadEnv();
