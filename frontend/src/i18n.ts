/**
 * next-intl request configuration (#576)
 *
 * This file is referenced by the next-intl plugin in next.config.js.
 * It provides message loading for server components. Client components
 * receive messages via NextIntlClientProvider in I18nProvider.tsx.
 *
 * Since we use a localStorage-based locale (no routing middleware), we default
 * to English on the server and let the client provider hydrate the correct locale.
 */
import { getRequestConfig } from "next-intl/server";
import enMessages from "@/locales/en.json";

export default getRequestConfig(async () => {
  // Default to English on server; client provider handles locale switching.
  const locale = "en";

  return {
    locale,
    messages: enMessages,
  };
});
