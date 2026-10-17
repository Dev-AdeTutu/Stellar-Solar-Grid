import { LOCALE_OPTIONS } from "@/components/I18nProvider";
import { useTranslations } from "next-intl";

export const SUPPORTED_LOCALES = LOCALE_OPTIONS.map((o) => o.value);

export function useTranslation(namespace?: string) {
  const t = useTranslations(namespace);
  return { t };
}
