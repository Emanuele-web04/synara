import { useMemo } from "react";
import { createInstance } from "i18next";
import { initReactI18next, useTranslation as useReactTranslation } from "react-i18next";

import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";
import { type LanguagePreference, readLanguagePreference, resolveLocale } from "./locale";
import spanish from "./locales/es.json";

function browserLanguages(): readonly string[] {
  return globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : globalThis.navigator?.language
      ? [globalThis.navigator.language]
      : [];
}

function storedPreference(): LanguagePreference {
  try {
    return readLanguagePreference(globalThis.localStorage);
  } catch {
    // Some browser privacy policies make accessing localStorage itself throw.
    return "system";
  }
}

let preference = storedPreference();
let synchronizedDesktopPreference:
  | {
      setter: NonNullable<NonNullable<Window["desktopBridge"]>["setLanguagePreference"]>;
      preference: LanguagePreference;
    }
  | undefined;

function syncDesktopLanguage(force = false): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const setter = bridge?.setLanguagePreference;
  if (typeof setter !== "function") return;
  if (
    !force &&
    synchronizedDesktopPreference?.setter === setter &&
    synchronizedDesktopPreference.preference === preference
  )
    return;
  const pending = { setter, preference };
  synchronizedDesktopPreference = pending;
  const synchronize = async () => {
    try {
      await setter.call(bridge, pending.preference);
    } catch (error) {
      if (synchronizedDesktopPreference === pending) synchronizedDesktopPreference = undefined;
      console.warn("[i18n] Could not synchronize the native language preference.", error);
    }
  };
  void synchronize();
}

export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: resolveLocale(preference, browserLanguages()),
  fallbackLng: "en",
  supportedLngs: ["en", "es"],
  resources: { en: { translation: {} }, es: { translation: spanish } },
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export function t(message: string, values?: Record<string, unknown>): string {
  return i18n.t(message, { ...values, defaultValue: message, returnObjects: false });
}

// A factory call ties identity to the subscription value without closing over its old
// language. An unused useCallback dependency is removed by React Compiler.
function createTranslationSnapshot(_subscription: unknown): { t: typeof t; formatLocale: string } {
  return {
    t: (message, values) => t(message, values),
    // Intl provides a validated regional locale for System. Passing it explicitly
    // makes React Compiler track formatting even when the interface language is unchanged.
    formatLocale: getFormatLocale() ?? new Intl.NumberFormat().resolvedOptions().locale,
  };
}

export function useTranslation(): { t: typeof t; locale: string; formatLocale: string } {
  const { t: reactiveTranslator, i18n: instance } = useReactTranslation(undefined, { i18n });
  // React Compiler needs a new identity on a language change. Delegating to the current
  // runtime also keeps callbacks already installed in native menus/event listeners current.
  const snapshot = useMemo(
    () => createTranslationSnapshot(reactiveTranslator),
    [reactiveTranslator],
  );
  return { ...snapshot, locale: instance.language };
}

export function getFormatLocale(): string | undefined {
  return preference === "system" ? undefined : preference;
}

function updateDocumentLanguage(): void {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.language;
}

/** Changes only the runtime; the existing app-settings hook owns persistence. */
export function setLanguagePreference(next: LanguagePreference): void {
  const locale = resolveLocale(next, browserLanguages());
  if (preference !== next || i18n.language !== locale) {
    preference = next;
    void i18n.changeLanguage(locale);
  }
  updateDocumentLanguage();
  syncDesktopLanguage();
}

/** Install before the first render; app settings already broadcasts same-tab writes. */
export function initializeI18n(): () => void {
  setLanguagePreference(storedPreference());
  if (typeof window === "undefined") return () => {};

  const syncPreference = () => setLanguagePreference(storedPreference());
  const onLanguageChange = () => {
    if (preference !== "system") return;
    // The browser's regional format can change while its supported base language stays the same.
    void i18n.changeLanguage(resolveLocale(preference, browserLanguages()));
    updateDocumentLanguage();
    syncDesktopLanguage(true);
  };
  const onStorageChange = (event: StorageEvent) => {
    if (
      (event.storageArea === null || event.storageArea === globalThis.localStorage) &&
      (event.key === null || event.key === APP_SETTINGS_STORAGE_KEY)
    ) {
      syncPreference();
    }
  };
  const onLocalChange = (event: Event) => {
    if ((event as CustomEvent<{ key: string }>).detail?.key === APP_SETTINGS_STORAGE_KEY) {
      syncPreference();
    }
  };

  window.addEventListener("languagechange", onLanguageChange);
  window.addEventListener("storage", onStorageChange);
  window.addEventListener("synara:local_storage_change", onLocalChange);
  return () => {
    window.removeEventListener("languagechange", onLanguageChange);
    window.removeEventListener("storage", onStorageChange);
    window.removeEventListener("synara:local_storage_change", onLocalChange);
  };
}
