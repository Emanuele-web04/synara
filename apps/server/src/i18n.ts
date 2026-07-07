import i18n, { type i18n as I18nInstance } from "i18next";
import { AsyncLocalStorage } from "node:async_hooks";

import en from "../../web/src/i18n/locales/en.json";
import zhCN from "../../web/src/i18n/locales/zh-CN.json";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const baseI18n: I18nInstance = i18n.createInstance();
baseI18n.init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

interface I18nLocaleStore {
  readonly locale: SupportedLocale;
}

const i18nLocaleStore = new AsyncLocalStorage<I18nLocaleStore>();

export function normalizeLocale(locale: string): SupportedLocale {
  if (SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
    return locale as SupportedLocale;
  }
  return "en";
}

export function runWithLocale<T>(locale: string, fn: () => T): T {
  const normalized = normalizeLocale(locale);
  return i18nLocaleStore.run({ locale: normalized }, fn);
}

export function t(key: string, options?: Record<string, unknown>): string {
  const store = i18nLocaleStore.getStore();
  const locale = store?.locale;
  if (locale) {
    return baseI18n.t(key, { lng: locale, ...options }) as string;
  }
  if (options) {
    return baseI18n.t(key, options) as string;
  }
  return baseI18n.t(key) as string;
}

export default baseI18n;
