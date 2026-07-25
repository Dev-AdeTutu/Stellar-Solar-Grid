interface ImportMetaEnv {
  readonly VITE_CONTRACT_ID: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_NETWORK_PASSPHRASE?: string;
  readonly VITE_SMS_SHORTCODE?: string;
  readonly VITE_SMS_WEBHOOK_DOCS?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
