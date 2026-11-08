import { useMemo } from "react";
import { createInstance } from "i18next";
import { initReactI18next, useTranslation as useReactTranslation } from "react-i18next";

import { uiLocalizationResources } from "@synara/shared/uiLocalizationResources";
import { UI_LOCALES, isUiMessageKey } from "@synara/shared/uiLocale";

// The interface is English-only: every message reads the English catalogs.
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: [...UI_LOCALES],
  resources: uiLocalizationResources,
  ns: Object.keys(uiLocalizationResources.en),
  defaultNS: "common",
  initAsync: false,
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
  react: { useSuspense: false, transSupportBasicHtmlNodes: false },
});

export function t(message: string, values?: Record<string, unknown>): string {
  if (!isUiMessageKey(message, uiLocalizationResources.en)) return message;
  return i18n.t(message, { ...values, returnObjects: false });
}

// A factory call ties identity to the subscription value without closing over its old
// state. An unused useCallback dependency is removed by React Compiler.
function createTranslationSnapshot(_subscription: unknown): { t: typeof t; formatLocale: string } {
  return {
    t: (message, values) => t(message, values),
    formatLocale: getFormatLocale(),
  };
}

export function useTranslation(): { t: typeof t; locale: string; formatLocale: string } {
  const { t: reactiveTranslator, i18n: instance } = useReactTranslation(undefined, { i18n });
  const snapshot = useMemo(
    () => createTranslationSnapshot(reactiveTranslator),
    [reactiveTranslator],
  );
  return { ...snapshot, locale: instance.language };
}

// Resolved once, like the formatters that used an unspecified `Intl` locale before.
const SYSTEM_FORMAT_LOCALE = new Intl.DateTimeFormat().resolvedOptions().locale;

/** Dates and numbers follow the system locale, as an unspecified `Intl` locale does. */
export function getFormatLocale(): string {
  return SYSTEM_FORMAT_LOCALE;
}
