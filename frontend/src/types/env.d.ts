declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_CONTRACT_ID: string;
    readonly NEXT_PUBLIC_BACKEND_URL?: string;
    readonly NEXT_PUBLIC_API_URL?: string;
    readonly NEXT_PUBLIC_RPC_URL?: string;
    readonly NEXT_PUBLIC_NETWORK_PASSPHRASE?: string;
    readonly NEXT_PUBLIC_SMS_SHORTCODE?: string;
    readonly NEXT_PUBLIC_SMS_WEBHOOK_DOCS?: string;
    readonly NEXT_PUBLIC_POLL_INTERVAL_MS?: string;
    readonly NEXT_PUBLIC_REQUEST_TIMEOUT_MS?: string;
  }
}
