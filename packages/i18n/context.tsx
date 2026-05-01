"use client";

import { createContext, useContext, useState, useCallback, useMemo } from "react";
import { createEnDict } from "./en";
import { createZhDict } from "./zh";
import type { AppDict, Locale } from "./types";

const dictionaryFactories: Record<Locale, () => AppDict> = {
  en: createEnDict,
  zh: createZhDict,
};

const COOKIE_NAME = "multica-locale";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

type LocaleContextValue = {
  locale: Locale;
  t: AppDict;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function getInitialLocale(): Locale {
  if (typeof document === "undefined") return "en";
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=(\\w+)`),
  );
  const stored = match?.[1];
  if (stored === "en" || stored === "zh") return stored;
  return "en";
}

export function AppLocaleProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);
  const t = useMemo(() => dictionaryFactories[locale](), [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.cookie = `${COOKIE_NAME}=${l}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
    document.documentElement.lang = l;
  }, []);

  return (
    <LocaleContext.Provider value={{ locale, t, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useAppLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useAppLocale must be used within AppLocaleProvider");
  return ctx;
}
