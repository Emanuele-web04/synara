import { useMemo } from "react";
import { createInstance } from "i18next";
import { initReactI18next, useTranslation as useReactTranslation } from "react-i18next";

import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";
import {
  type LanguagePreference,
  type SupportedLocale,
  readLanguagePreference,
  resolveLanguagePreference,
  resolveLocale,
  UI_LOCALES,
} from "./locale";
import { uiLocalizationResources } from "@synara/shared/uiLocalizationResources";
import { UI_LOCALE_REGISTRY, isUiMessageKey } from "@synara/shared/uiLocale";

function browserLanguages(): readonly string[] {
  try {
    const nativeLanguages =
      typeof window === "undefined" ? undefined : window.desktopBridge?.getSystemLanguages?.();
    if (nativeLanguages?.length) return nativeLanguages;
  } catch {
    // An older or unavailable native bridge must not prevent the renderer from booting.
  }
  return globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : globalThis.navigator?.language
      ? [globalThis.navigator.language]
      : [];
}

function storedPreference(): LanguagePreference {
  return readLanguagePreference();
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
  const nativePreference = resolveLanguagePreference(preference);
  if (
    !force &&
    synchronizedDesktopPreference?.setter === setter &&
    synchronizedDesktopPreference.preference === nativePreference
  )
    return;
  const pending = { setter, preference: nativePreference };
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
  lng: resolveLocale(
    preference,
    resolveLanguagePreference(preference) === "system" ? browserLanguages() : [],
  ),
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
// language. An unused useCallback dependency is removed by React Compiler.
function createTranslationSnapshot(_subscription: unknown): { t: typeof t; formatLocale: string } {
  return {
    t: (message, values) => t(message, values),
    formatLocale: getFormatLocale(),
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

export function getFormatLocale(): string {
  return i18n.language;
}

function updateDocumentLanguage(locale: SupportedLocale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = UI_LOCALE_REGISTRY[locale].direction;
  }
}

/** Changes only the runtime; the existing app-settings hook owns persistence. */
export function setLanguagePreference(next: LanguagePreference): void {
  const locale = resolveLocale(
    next,
    resolveLanguagePreference(next) === "system" ? browserLanguages() : [],
  );
  if (preference !== next || i18n.language !== locale) {
    preference = next;
    void i18n.changeLanguage(locale);
  }
  updateDocumentLanguage(locale);
  syncDesktopLanguage();
}

/** Install before the first render; app settings already broadcasts same-tab writes. */
export function initializeI18n(): () => void {
  setLanguagePreference(storedPreference());
  if (typeof window === "undefined") return () => {};

  const syncPreference = () => setLanguagePreference(storedPreference());
  const onLanguageChange = () => {
    if (resolveLanguagePreference(preference) !== "system") return;
    // Refresh native candidates once: preload values would otherwise stay frozen at launch.
    const locale = resolveLocale(preference, browserLanguages());
    void i18n.changeLanguage(locale);
    updateDocumentLanguage(locale);
    syncDesktopLanguage(true);
  };
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_SETTINGS_STORAGE_KEY) {
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
