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
import { uiLocalizationResourcesEn } from "@synara/shared/uiLocalizationResourcesEn";
import { UI_LOCALE_REGISTRY, isUiMessageKey } from "@synara/shared/uiLocale";

type LocaleBundles = Readonly<Record<string, Readonly<Record<string, string>>>>;

const loadedLocales = new Set<SupportedLocale>(["en"]);
const loadingLocalePromises = new Map<SupportedLocale, Promise<void>>();

async function loadLocaleBundles(locale: SupportedLocale): Promise<LocaleBundles | null> {
  if (locale === "en") return uiLocalizationResourcesEn;
  if (locale === "es") {
    const mod = await import("@synara/shared/uiLocalizationResourcesEs");
    return mod.uiLocalizationResourcesEs;
  }
  if (locale === "zh-CN") {
    const mod = await import("@synara/shared/uiLocalizationResourcesZhCn");
    return mod.uiLocalizationResourcesZhCn;
  }
  return null;
}

function registerLocaleBundles(locale: SupportedLocale, bundles: LocaleBundles): void {
  for (const [namespace, resources] of Object.entries(bundles)) {
    i18n.addResourceBundle(locale, namespace, resources, true, true);
  }
  loadedLocales.add(locale);
}

export function ensureLocaleLoaded(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve();
  const inFlight = loadingLocalePromises.get(locale);
  if (inFlight) return inFlight;
  const promise = loadLocaleBundles(locale)
    .then((bundles) => {
      if (bundles) registerLocaleBundles(locale, bundles);
    })
    .finally(() => {
      loadingLocalePromises.delete(locale);
    });
  loadingLocalePromises.set(locale, promise);
  return promise;
}

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

// In Vitest, tests synchronously switch locales and assert immediate translations.
// In production builds, Vite constant-folds `import.meta.env.MODE === "test"` to
// `false`, tree-shaking non-English locale JSON (~640 KB raw / ~145 KB br) into
// on-demand dynamic chunks loaded only when that locale is active.
const initialResources: Record<string, LocaleBundles> = {
  en: uiLocalizationResourcesEn,
};
if (import.meta.env.MODE === "test") {
  const { uiLocalizationResources } = await import("@synara/shared/uiLocalizationResources");
  for (const locale of UI_LOCALES) {
    if (locale !== "en") {
      initialResources[locale] = uiLocalizationResources[locale];
      loadedLocales.add(locale);
    }
  }
}

const initialLocale = resolveLocale(
  preference,
  resolveLanguagePreference(preference) === "system" ? browserLanguages() : [],
);

export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: loadedLocales.has(initialLocale) ? initialLocale : "en",
  fallbackLng: "en",
  supportedLngs: [...UI_LOCALES],
  resources: initialResources,
  ns: Object.keys(uiLocalizationResourcesEn),
  defaultNS: "common",
  initAsync: false,
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
  react: { useSuspense: false, transSupportBasicHtmlNodes: false },
});

if (!loadedLocales.has(initialLocale)) {
  void ensureLocaleLoaded(initialLocale).then(() => {
    const currentResolved = resolveLocale(
      preference,
      resolveLanguagePreference(preference) === "system" ? browserLanguages() : [],
    );
    if (currentResolved === initialLocale && i18n.language !== initialLocale) {
      void i18n.changeLanguage(initialLocale);
    }
  });
}

export function t(message: string, values?: Record<string, unknown>): string {
  if (!isUiMessageKey(message, uiLocalizationResourcesEn)) return message;
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

function applyResolvedLocale(locale: SupportedLocale): void {
  if (loadedLocales.has(locale)) {
    void i18n.changeLanguage(locale);
    return;
  }
  void ensureLocaleLoaded(locale).then(() => {
    const latest = resolveLocale(
      preference,
      resolveLanguagePreference(preference) === "system" ? browserLanguages() : [],
    );
    if (latest === locale) {
      void i18n.changeLanguage(locale);
    }
  });
}

/** Changes only the runtime; the existing app-settings hook owns persistence. */
export function setLanguagePreference(next: LanguagePreference): void {
  const locale = resolveLocale(
    next,
    resolveLanguagePreference(next) === "system" ? browserLanguages() : [],
  );
  if (preference !== next || i18n.language !== locale) {
    preference = next;
    applyResolvedLocale(locale);
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
    applyResolvedLocale(locale);
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
