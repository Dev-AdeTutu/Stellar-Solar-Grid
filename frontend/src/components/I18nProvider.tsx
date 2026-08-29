"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "@/locales/en.json";
import frMessages from "@/locales/fr.json";
import swMessages from "@/locales/sw.json";

export type Locale = "en" | "fr" | "sw";

export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "sw", label: "Kiswahili" },
];

const STORAGE_KEY = "sg_locale";
const SUPPORTED_LOCALES: Locale[] = LOCALE_OPTIONS.map(({ value }) => value);
const DEFAULT_LOCALE: Locale = "en";

const messages: Record<Locale, typeof enMessages> = {
  en: enMessages,
  fr: frMessages,
  sw: swMessages,
};

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

  return (
    <I18nContext.Provider value={{ locale: activeLocale, setLocale, toggleLocale }}>
      <NextIntlClientProvider locale={activeLocale} messages={messages[activeLocale]}>
        {children}
      </NextIntlClientProvider>
    </I18nContext.Provider>
  );
}
