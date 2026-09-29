"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "@/locales/en.json";
import frMessages from "@/locales/fr.json";
import swMessages from "@/locales/sw.json";
import esMessages from "@/locales/es.json";
import deMessages from "@/locales/de.json";
import zhMessages from "@/locales/zh.json";
import arMessages from "@/locales/ar.json";

export type Locale = "en" | "es" | "fr" | "de" | "zh" | "ar" | "sw";

export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "zh", label: "中文" },
  { value: "ar", label: "العربية" },
  { value: "sw", label: "Kiswahili" },
];

/** Locales rendered right-to-left (#894). */
export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar"]);

/** BCP-47 tag + display currency per locale for Intl formatting (#894). */
export const LOCALE_FORMATS: Record<Locale, { intl: string; currency: string }> = {
  en: { intl: "en-US", currency: "USD" },
  es: { intl: "es-ES", currency: "EUR" },
  fr: { intl: "fr-FR", currency: "EUR" },
  de: { intl: "de-DE", currency: "EUR" },
  zh: { intl: "zh-CN", currency: "CNY" },
  ar: { intl: "ar-EG", currency: "EGP" },
  sw: { intl: "sw-KE", currency: "KES" },
};

const STORAGE_KEY = "sg_locale";
const SUPPORTED_LOCALES: Locale[] = LOCALE_OPTIONS.map(({ value }) => value);
const DEFAULT_LOCALE: Locale = "en";

type Messages = { [key: string]: string | Messages };

/** Deep-merge a locale over English so any missing key falls back to English. */
function withFallback(base: Messages, overrides: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = typeof v === "object" && typeof base[k] === "object" ? withFallback(base[k] as Messages, v) : v;
  }
  return out;
}

const messages = {
  en: enMessages,
  es: withFallback(enMessages, esMessages),
  fr: withFallback(enMessages, frMessages),
  de: withFallback(enMessages, deMessages),
  zh: withFallback(enMessages, zhMessages),
  ar: withFallback(enMessages, arMessages),
  sw: withFallback(enMessages, swMessages),
} as Record<Locale, typeof enMessages>;

// ── Context ───────────────────────────────────────────────────────────────

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  toggleLocale: () => {},
});

export function useLocale() {
  return useContext(I18nContext);
}

/** Locale-aware number, currency and date formatters (#894). */
export function useFormatters() {
  const { locale } = useLocale();
  const { intl, currency } = LOCALE_FORMATS[locale];
  return {
    formatNumber: (n: number, maxFractionDigits = 2) =>
      new Intl.NumberFormat(intl, { maximumFractionDigits: maxFractionDigits }).format(n),
    formatCurrency: (n: number, code: string = currency) =>
      new Intl.NumberFormat(intl, { style: "currency", currency: code }).format(n),
    formatDate: (d: string | number | Date) =>
      new Intl.DateTimeFormat(intl, { dateStyle: "medium" }).format(new Date(d)),
    formatDateTime: (d: string | number | Date) =>
      new Intl.DateTimeFormat(intl, { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)),
  };
}

// ── Provider ──────────────────────────────────────────────────────────────

/**
 * I18nProvider
 *
 * Wraps the app with NextIntlClientProvider. Locale preference is stored in
 * localStorage and restored on page load. Falls back to "en" if the stored
 * value is not recognised.
 *
 * Usage:
 *   <I18nProvider>{children}</I18nProvider>
 *
 * Then in any Client Component:
 *   const t = useTranslations("nav");
 *   const { toggleLocale } = useLocale();
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [mounted, setMounted] = useState(false);

  // Read persisted preference on first client render
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (stored && SUPPORTED_LOCALES.includes(stored)) {
      setLocaleState(stored);
    }
    setMounted(true);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    setLocaleState(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const toggleLocale = useCallback(() => {
    const currentIndex = SUPPORTED_LOCALES.indexOf(locale);
    const nextLocale = SUPPORTED_LOCALES[(currentIndex + 1) % SUPPORTED_LOCALES.length];
    setLocale(nextLocale);
  }, [locale, setLocale]);

  // Avoid hydration mismatch: render with default locale on server / before
  // the localStorage read completes, then swap once mounted.
  const activeLocale = mounted ? locale : DEFAULT_LOCALE;

  // Keep <html lang/dir> in sync so RTL layouts flip correctly.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = activeLocale;
    document.documentElement.dir = RTL_LOCALES.has(activeLocale) ? "rtl" : "ltr";
  }, [activeLocale]);

  return (
    <I18nContext.Provider value={{ locale: activeLocale, setLocale, toggleLocale }}>
      <NextIntlClientProvider locale={activeLocale} messages={messages[activeLocale]}>
        {children}
      </NextIntlClientProvider>
    </I18nContext.Provider>
  );
}
